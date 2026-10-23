/**
 * Projects: one person, many workspaces.
 *
 * Each project is a complete workspace (its own gateway, connections, people
 * and state). A person's first project is the workspace made for them at
 * sign-in; that one also keeps the list of every project they own or joined.
 *
 *   GET    /v1/projects               my projects, with my role in each
 *   POST   /v1/projects               { name } create a project (I am admin)
 *   POST   /v1/projects/remember      add the project I am in to my list
 *   POST   /v1/projects/:id/switch    session for another project of mine
 *   PATCH  /v1/projects/:id           { name } rename (owner only)
 *   DELETE /v1/projects/:id           { confirm } lock a project (owner only)
 *
 * Who is a member is decided by the project itself: an invitation for the
 * person's verified e-mail address. Being on the list alone gives no access.
 */
import { randomUUID } from 'node:crypto';
import { errors } from '@sethucms/core';
import type { Services } from './services.js';
import type { Role, StoredProject } from '../store/state.js';
import type { Workspaces } from '../tenancy.js';

/** The parts of the workspace hub the project routes use. */
export type ProjectsHub = Pick<Workspaces, 'idFor' | 'mint' | 'get' | 'valid'>;

/** Projects one person may own, the first included. */
export const MAX_OWNED_PROJECTS = 5;
const NAME_MAX = 60;
const DEFAULT_NAME = 'My project';
const ROLE_ORDER: Role[] = ['viewer', 'editor', 'admin'];

/** Who is calling, taken from their sign-in session. */
interface Caller {
  uid: string;
  subject: string;
  email: string;
  hoursLeft: number;
}

/** A project as the admin app shows it. */
interface ProjectView {
  id: string;
  name: string;
  owner: boolean;
  role: Role | null;
  current: boolean;
}

/**
 * Check a project name: 1 to 60 characters, no control characters.
 * @throws a validation error otherwise
 */
export function cleanProjectName(value: unknown): string {
  if (typeof value !== 'string') {
    throw errors.validation('name is required');
  }
  const name = value.trim().replace(/\s+/g, ' ');
  // eslint-disable-next-line no-control-regex
  if (name === '' || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
    throw errors.validation(`name must be 1 to ${NAME_MAX} characters`);
  }
  return name;
}

/** The session of a person who signed in with Google or GitHub. */
function callerOf(s: Services, tokenId: string): Caller {
  const token = s.store.read().tokens[tokenId];
  const subject = token?.subject ?? '';
  if (!token || !subject.startsWith('firebase:') || !token.name.includes('@')) {
    throw errors.forbidden('Projects need a Google or GitHub sign-in');
  }
  const left = token.expiresAt ? Date.parse(token.expiresAt) - Date.now() : 0;
  return {
    uid: subject.slice('firebase:'.length),
    subject,
    email: token.name.toLowerCase(),
    // A new session never outlives the one used to ask for it.
    hoursLeft: Math.min(24, Math.max(1, Math.floor(left / 3_600_000))),
  };
}

/** The role an invitation gives this e-mail address in a project, if any. */
function roleIn(project: Services, email: string): Role | null {
  const invite = Object.values(project.store.read().invites).find(
    (item) => item.email === email,
  );
  return invite?.role ?? null;
}

/** Add or raise an invitation in a project's own state. */
async function invite(project: Services, email: string, role: Role, by: string): Promise<void> {
  await project.store.update((state) => {
    const existing = Object.values(state.invites).find((item) => item.email === email);
    if (existing) {
      if (ROLE_ORDER.indexOf(role) > ROLE_ORDER.indexOf(existing.role)) {
        existing.role = role;
      }
      return;
    }
    const id = `inv_${randomUUID().slice(0, 8)}`;
    state.invites[id] = { id, email, role, createdAt: new Date().toISOString(), createdBy: by };
  });
}

/**
 * Register the project routes on a workspace gateway.
 * @param current This gateway's own workspace id.
 */
export function registerProjectRoutes(
  s: Services,
  deps: { hub: ProjectsHub; current: string },
): void {
  const { hub, current } = deps;

  /** The person's first project: its state holds their list. */
  const homeOf = async (caller: Caller) => {
    const id = hub.idFor(caller.uid);
    const gateway = await hub.get(id);
    return { id, gateway, services: gateway.services };
  };

  /** Make sure the list has its first entry; returns the list. */
  const listOf = async (
    home: Awaited<ReturnType<typeof homeOf>>,
  ): Promise<Record<string, StoredProject>> => {
    if (!home.services.store.read().projects[home.id]) {
      await home.services.store.update((state) => {
        state.projects[home.id] ??= {
          id: home.id,
          name: DEFAULT_NAME,
          owner: true,
          createdAt: new Date().toISOString(),
        };
      });
    }
    return home.services.store.read().projects;
  };

  /** Open a session for the caller in a project they belong to. */
  const enter = async (
    caller: Caller,
    id: string,
  ): Promise<{ token: string; expiresAt: string; role: Role }> => {
    if (!hub.valid(id)) {
      throw errors.notFound('Project not found');
    }
    const target = (await hub.get(id)).services;
    const role = roleIn(target, caller.email);
    if (!role) {
      throw errors.notFound('Project not found');
    }
    const session = await target.auth.createSession(
      caller.email,
      role,
      caller.subject,
      caller.hoursLeft,
    );
    target.audit.record({
      actor: session.id,
      operation: 'auth.project.switch',
      target: id,
      requestId: '',
      detail: { role },
    });
    return { token: session.token, expiresAt: session.expiresAt, role };
  };

  s.router.add({
    method: 'GET',
    pattern: '/v1/projects',
    auth: 'token',
    handler: async (ctx) => {
      const caller = callerOf(s, ctx.principal.id);
      const home = await homeOf(caller);
      const list = await listOf(home);
      const projects: ProjectView[] = Object.values(list)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((item) => ({
          id: item.id,
          name: item.name,
          owner: item.owner,
          role: item.role ?? null,
          current: item.id === current,
        }));
      return {
        status: 200,
        body: { data: { current, limit: MAX_OWNED_PROJECTS, projects } },
      };
    },
  });

  s.router.add({
    method: 'POST',
    pattern: '/v1/projects',
    auth: 'token',
    expensive: true,
    handler: async (ctx) => {
      const caller = callerOf(s, ctx.principal.id);
      const body = (await ctx.json().catch(() => undefined)) as { name?: unknown } | undefined;
      const name = cleanProjectName(body?.name);
      const home = await homeOf(caller);
      const list = await listOf(home);
      const owned = Object.values(list).filter((item) => item.owner).length;
      if (owned >= MAX_OWNED_PROJECTS) {
        throw errors.conflict(`You can own up to ${MAX_OWNED_PROJECTS} projects`);
      }
      const id = hub.mint();
      const project = (await hub.get(id)).services;
      await invite(project, caller.email, 'admin', 'owner');
      const session = await project.auth.createSession(
        caller.email,
        'admin',
        caller.subject,
        caller.hoursLeft,
      );
      project.audit.record({
        actor: session.id,
        operation: 'project.create',
        target: id,
        requestId: ctx.requestId,
      });
      await home.services.store.update((state) => {
        state.projects[id] = {
          id,
          name,
          owner: true,
          role: 'admin',
          createdAt: new Date().toISOString(),
        };
      });
      await (await hub.get(id)).flush().catch(() => undefined);
      await home.gateway.flush().catch(() => undefined);
      return {
        status: 201,
        body: {
          data: {
            id,
            name,
            role: 'admin',
            token: session.token,
            expiresAt: session.expiresAt,
            workspace: id,
          },
        },
      };
    },
  });

  s.router.add({
    method: 'POST',
    pattern: '/v1/projects/remember',
    auth: 'token',
    handler: async (ctx) => {
      const caller = callerOf(s, ctx.principal.id);
      const home = await homeOf(caller);
      await listOf(home);
      if (current !== home.id) {
        await home.services.store.update((state) => {
          const existing = state.projects[current];
          state.projects[current] = existing
            ? { ...existing, role: ctx.principal.role }
            : {
                id: current,
                name: 'Shared project',
                owner: false,
                role: ctx.principal.role,
                createdAt: new Date().toISOString(),
              };
        });
        await home.gateway.flush().catch(() => undefined);
      }
      return { status: 200, body: { data: { id: current } } };
    },
  });

  s.router.add({
    method: 'POST',
    pattern: '/v1/projects/:id/switch',
    auth: 'token',
    expensive: true,
    handler: async (ctx) => {
      const caller = callerOf(s, ctx.principal.id);
      const id = ctx.params['id'] ?? '';
      const home = await homeOf(caller);
      const list = await listOf(home);
      if (!list[id]) {
        throw errors.notFound('Project not found');
      }
      const session = await enter(caller, id);
      await home.services.store.update((state) => {
        const item = state.projects[id];
        if (item) {
          item.role = session.role;
        }
      });
      return {
        status: 200,
        body: {
          data: {
            id,
            name: list[id]?.name,
            role: session.role,
            token: session.token,
            expiresAt: session.expiresAt,
            workspace: id,
          },
        },
      };
    },
  });

  s.router.add({
    method: 'PATCH',
    pattern: '/v1/projects/:id',
    auth: 'token',
    handler: async (ctx) => {
      const caller = callerOf(s, ctx.principal.id);
      const id = ctx.params['id'] ?? '';
      const body = (await ctx.json().catch(() => undefined)) as { name?: unknown } | undefined;
      const name = cleanProjectName(body?.name);
      const home = await homeOf(caller);
      const list = await listOf(home);
      if (!list[id]?.owner) {
        throw errors.notFound('Project not found');
      }
      await home.services.store.update((state) => {
        const item = state.projects[id];
        if (item) {
          item.name = name;
        }
      });
      await home.gateway.flush().catch(() => undefined);
      return { status: 200, body: { data: { id, name } } };
    },
  });

  s.router.add({
    method: 'DELETE',
    pattern: '/v1/projects/:id',
    auth: 'token',
    expensive: true,
    handler: async (ctx) => {
      const caller = callerOf(s, ctx.principal.id);
      const id = ctx.params['id'] ?? '';
      const body = (await ctx.json().catch(() => undefined)) as { confirm?: unknown } | undefined;
      const home = await homeOf(caller);
      const list = await listOf(home);
      const item = list[id];
      if (!item?.owner) {
        throw errors.notFound('Project not found');
      }
      if (id === home.id) {
        throw errors.conflict('Your first project cannot be deleted');
      }
      if (body?.confirm !== item.name) {
        throw errors.validation('Type the project name to confirm');
      }
      // Lock it: no invitation and no live session survives. The data stays in
      // the project's own database until the owner removes it there.
      const project = (await hub.get(id)).services;
      await project.store.update((state) => {
        state.invites = {};
        const now = new Date().toISOString();
        for (const token of Object.values(state.tokens)) {
          token.revokedAt ??= now;
        }
      });
      project.audit.record({
        actor: ctx.principal.id,
        operation: 'project.delete',
        target: id,
        requestId: ctx.requestId,
      });
      await home.services.store.update((state) => {
        delete state.projects[id];
      });
      await (await hub.get(id)).flush().catch(() => undefined);
      await home.gateway.flush().catch(() => undefined);
      return { status: 200, body: { data: { id, deleted: true } } };
    },
  });
}
