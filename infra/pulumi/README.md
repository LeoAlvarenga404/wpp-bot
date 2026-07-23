# wpp-bot — Pulumi IaC (AWS Lightsail)

Provisions the single-box host for wpp-bot: a Lightsail instance (2GB/2vCPU,
São Paulo), a static IP, an SSH-only firewall, and a first-boot bootstrap that
installs Docker + compose, carves a 2GB swap and clones the repo.

Optionally (when `hostname` is set) it also provisions the **Cloudflare
Tunnel** + its ingress config + the **DNS CNAME**, and emits the tunnel token.
Cloudflare **Access** (the auth gate) stays a dashboard step — Fase 5 do
runbook — because its Pulumi shapes are version-fragile.

**What this does NOT do (stays manual — see `docs/deploy/lightsail.md`):**
`.env` secrets, the Baileys QR scan, and copying the Playwright
`playwright-state.json` (a headed login can't run on a headless server). The
bootstrap drops a `~/NEXT_STEPS.txt` checklist on the box.

## Prereqs

- [Pulumi CLI](https://www.pulumi.com/docs/install/) + an account/backend
  (`pulumi login`).
- AWS credentials in the environment (`aws configure` / `AWS_ACCESS_KEY_ID`…).
- Node 20+.

## Use

```bash
cd infra/pulumi
npm install

pulumi stack init prod

# optional overrides (defaults already target 2GB / sa-east-1)
pulumi config set wpp-bot-infra:bundleId small_2_0     # medium_2_0 = 4GB
pulumi config set wpp-bot-infra:sshKeyName my-lightsail-key   # else default key
pulumi config set wpp-bot-infra:sshCidr 203.0.113.4/32       # lock SSH to your IP

pulumi up
```

Outputs the public IP and the `ssh` command. Then:

```bash
ssh ubuntu@<publicIp>
cat ~/NEXT_STEPS.txt      # finish .env, playwright-state, compose up, QR, tunnel
```

### With the Cloudflare Tunnel (optional)

```bash
export CLOUDFLARE_API_TOKEN=<token with Tunnel+DNS edit>
pulumi config set wpp-bot-infra:hostname painel.seudominio.com
pulumi config set wpp-bot-infra:cloudflareAccountId <account-id>
pulumi config set wpp-bot-infra:cloudflareZoneId <zone-id>
pulumi up
```

Then on the box, install cloudflared with the emitted token:

```bash
pulumi stack output cloudflaredInstallToken --show-secrets   # copy the token
# on the instance:
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cf.deb
sudo dpkg -i cf.deb
sudo cloudflared service install <token>
```

Finish by adding an **Access** application+policy for the hostname in the Zero
Trust dashboard (Fase 5 do runbook).

> The Cloudflare block targets **pulumi-cloudflare v5**. Run `pulumi preview`
> first; if your provider major differs, resource names may need a tweak.

## Config keys

| key | default | notes |
|-----|---------|-------|
| `region` | `sa-east-1` | Lightsail region |
| `availabilityZone` | `sa-east-1a` | must be inside region |
| `bundleId` | `small_2_0` | 2GB/2vCPU (~$12/mo). `medium_2_0` = 4GB |
| `blueprintId` | `ubuntu_22_04` | OS image |
| `repoUrl` | this repo | bootstrap clones it |
| `sshKeyName` | *(empty)* | existing Lightsail key-pair; empty = region default |
| `sshCidr` | `0.0.0.0/0` | tighten to your IP |
| `hostname` | *(empty)* | set to provision the Cloudflare Tunnel + DNS |
| `cloudflareAccountId` | *(empty)* | required when `hostname` set |
| `cloudflareZoneId` | *(empty)* | required when `hostname` set |

Env for the Cloudflare block: `CLOUDFLARE_API_TOKEN` (Tunnel + DNS edit).

## Teardown

```bash
pulumi destroy
```

Destroys the instance + IP. **Back up first** — `auth_info/` (Baileys creds +
Playwright state) and the Postgres volume live on the instance disk. Take a
Lightsail snapshot before destroying.
