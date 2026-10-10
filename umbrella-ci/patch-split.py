"""Splits the real-database tests out of the Everything workflow.

Run from the root of the sethucms repository:  python3 umbrella-ci/patch-split.py
 - installs .github/workflows/databases.yml and .github/actions/workspace/action.yml
 - removes the real-server step from .github/workflows/everything.yml
Safe to run twice."""
import pathlib, shutil
root = pathlib.Path('.')
src = root / 'umbrella-ci'
(root / '.github/actions/workspace').mkdir(parents=True, exist_ok=True)
shutil.copy(src / 'databases.yml', root / '.github/workflows/databases.yml')
shutil.copy(src / 'workspace-action.yml', root / '.github/actions/workspace/action.yml')

p = root / '.github/workflows/everything.yml'
s = p.read_text()
step = '''
      - name: Adapters against real MongoDB, MySQL, MariaDB, PostgreSQL and Firestore emulator
        run: sh sethucms/scripts/test-real-servers.sh
'''
s = s.replace(step, '\n')
s = s.replace('''#   1. build-and-test : build all repos in dependency order, run every unit test,
#                       run the adapters against REAL MongoDB, MySQL, MariaDB,
#                       PostgreSQL and the Firestore emulator.''',
'''#   1. build-and-test : build all repos in dependency order and run every unit test
#                       (the gateway against live PostgreSQL).
#                       The adapters against every real database run in their own
#                       workflow: databases.yml.''')
s = s.replace('name: Build, test, real databases', 'name: Build and test')
p.write_text(s.rstrip('\n') + '\n')
print('split done')
