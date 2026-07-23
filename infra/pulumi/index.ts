import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as cloudflare from '@pulumi/cloudflare';
import * as random from '@pulumi/random';

// --- config -----------------------------------------------------------------
const cfg = new pulumi.Config();
const region = cfg.get('region') ?? 'sa-east-1';
const availabilityZone = cfg.get('availabilityZone') ?? 'sa-east-1a';
const bundleId = cfg.get('bundleId') ?? 'small_3_1'; // 2GB / 2vCPU (gen 3.1, IPv4)
const blueprintId = cfg.get('blueprintId') ?? 'ubuntu_22_04';
const repoUrl =
  cfg.get('repoUrl') ?? 'https://github.com/LeoAlvarenga404/wpp-bot.git';
const sshKeyName = cfg.get('sshKeyName') ?? '';

// Pin the AWS provider to the chosen region so Lightsail lands in São Paulo
// regardless of the ambient AWS_REGION.
const provider = new aws.Provider('aws', { region: region as aws.Region });
const opts = { provider };

// --- bootstrap ---------------------------------------------------------------
// Runs once on first boot (cloud-init). Installs Docker + compose, carves a 2GB
// swap file (the cushion for the Chromium peak on a 2GB box), clones the repo
// and pre-creates the bind-mount dirs. It deliberately does NOT bring the stack
// up: that needs the .env, the Baileys QR scan and the Playwright
// storage-state, all of which are manual (docs/deploy/lightsail.md).
const userData = `#!/bin/bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update && apt-get upgrade -y

# Docker + compose plugin
curl -fsSL https://get.docker.com | sh
usermod -aG docker ubuntu

# 2GB swap — survives the intermittent Chromium peak on a 2GB instance
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Clone repo + pre-create the bind-mount dirs the compose expects
cd /home/ubuntu
if [ ! -d wpp-bot ]; then
  sudo -u ubuntu git clone ${repoUrl}
fi
cd wpp-bot
sudo -u ubuntu mkdir -p auth_info data config

# Leave the operator a checklist of the manual steps IaC can't do
cat > /home/ubuntu/NEXT_STEPS.txt <<'EOF'
Host provisioned. Remaining MANUAL steps (see docs/deploy/lightsail.md):
  1. Fill ~/wpp-bot/.env (prod values; strong 32+ char API_KEY).
  2. scp auth_info/playwright-state.json from your laptop into ~/wpp-bot/auth_info/
     (Playwright headed login can't run on a headless server).
  3. docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
  4. Scan the Baileys QR from: docker compose logs -f app
  5. Install cloudflared tunnel + Cloudflare Access (Fase 5 do runbook).
EOF
chown ubuntu:ubuntu /home/ubuntu/NEXT_STEPS.txt
`;

// --- resources ---------------------------------------------------------------
const staticIp = new aws.lightsail.StaticIp('wpp-bot-ip', {}, opts);

const instance = new aws.lightsail.Instance(
  'wpp-bot',
  {
    availabilityZone,
    blueprintId,
    bundleId,
    userData,
    ...(sshKeyName ? { keyPairName: sshKeyName } : {}),
    tags: { app: 'wpp-bot', managedBy: 'pulumi' },
  },
  opts,
);

new aws.lightsail.StaticIpAttachment(
  'wpp-bot-ip-attach',
  { staticIpName: staticIp.name, instanceName: instance.name },
  opts,
);

// SSH only. No inbound 80/443 — Cloudflare Tunnel dials out, nothing is exposed
// publicly. Tighten sshCidr to your IP for extra safety.
const sshCidr = cfg.get('sshCidr') ?? '0.0.0.0/0';
new aws.lightsail.InstancePublicPorts(
  'wpp-bot-ports',
  {
    instanceName: instance.name,
    portInfos: [
      { protocol: 'tcp', fromPort: 22, toPort: 22, cidrs: [sshCidr] },
    ],
  },
  opts,
);

// --- Cloudflare Tunnel + DNS (optional) -------------------------------------
// Enabled only when `hostname` is set. Creates a remotely-managed tunnel, its
// ingress config (hostname -> the app on localhost:3000) and the DNS CNAME.
// Requires CLOUDFLARE_API_TOKEN in the environment plus the account/zone ids.
//
// Access (the auth gate in front of the hostname) is intentionally left to the
// Zero Trust dashboard: its Pulumi resource shapes shift a lot between provider
// majors, and a dashboard app+policy is a 2-minute, low-risk step (Fase 5 do
// runbook). Validate this block with `pulumi preview` — targets
// pulumi-cloudflare v5.
//
// The operator installs cloudflared on the box with the emitted token:
//   sudo cloudflared service install <tunnelToken>
const hostname = cfg.get('hostname');
let tunnelToken: pulumi.Output<string> | undefined;

if (hostname) {
  const accountId = cfg.require('cloudflareAccountId');
  const zoneId = cfg.require('cloudflareZoneId');

  const tunnelSecret = new random.RandomBytes('wpp-bot-tunnel-secret', {
    length: 32,
  });

  const tunnel = new cloudflare.ZeroTrustTunnelCloudflared('wpp-bot-tunnel', {
    accountId,
    name: 'wpp-bot',
    secret: tunnelSecret.base64,
    configSrc: 'cloudflare',
  });

  new cloudflare.ZeroTrustTunnelCloudflaredConfig('wpp-bot-tunnel-config', {
    accountId,
    tunnelId: tunnel.id,
    config: {
      ingressRules: [
        { hostname, service: 'http://localhost:3000' },
        { service: 'http_status:404' },
      ],
    },
  });

  new cloudflare.Record('wpp-bot-dns', {
    zoneId,
    name: hostname,
    type: 'CNAME',
    content: pulumi.interpolate`${tunnel.id}.cfargotunnel.com`,
    proxied: true,
  });

  // Token cloudflared uses to run the tunnel — exposed on the resource.
  tunnelToken = tunnel.tunnelToken;
}

// --- outputs -----------------------------------------------------------------
export const publicIp = staticIp.ipAddress;
export const sshCommand = pulumi.interpolate`ssh ubuntu@${staticIp.ipAddress}`;
export const nextSteps = pulumi.interpolate`ssh in, then: cat ~/NEXT_STEPS.txt`;
export const panelUrl = hostname ? `https://${hostname}` : undefined;
// `pulumi stack output tunnelToken --show-secrets` → run on the box:
//   sudo cloudflared service install <token>
export const cloudflaredInstallToken = tunnelToken
  ? pulumi.secret(tunnelToken)
  : undefined;
