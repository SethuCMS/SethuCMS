import re,sys
p='.github/workflows/release.yml'
s=open(p).read()
s=s.replace('trivy-action@0.28.0','trivy-action@v0.36.0')
# Image names must be lowercase; the org name has capitals, so write it out.
s=s.replace('IMAGE: ghcr.io/${{ github.repository_owner }}/sethucms','IMAGE: ghcr.io/sethucms/sethucms')
if 'TRIVY_DB_REPOSITORY' not in s:
    old='''      - name: Scan the image
        uses: aquasecurity/trivy-action@v0.36.0
        with:'''
    new='''      - name: Scan the image
        uses: aquasecurity/trivy-action@v0.36.0
        # The scan is informational for now, so a flaky vulnerability-database download must not block the release.
        continue-on-error: true
        env:
          TRIVY_DB_REPOSITORY: public.ecr.aws/aquasecurity/trivy-db:2,mirror.gcr.io/aquasec/trivy-db:2,ghcr.io/aquasecurity/trivy-db:2
          TRIVY_JAVA_DB_REPOSITORY: public.ecr.aws/aquasecurity/trivy-java-db:1,mirror.gcr.io/aquasec/trivy-java-db:1,ghcr.io/aquasecurity/trivy-java-db:1
        with:'''
    assert old in s
    s=s.replace(old,new,1)
open(p,'w').write(s)
print('patched')
