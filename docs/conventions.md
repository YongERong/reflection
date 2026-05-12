# Development Conventions

## Local Telegram Bot Development

Use the combined local dev command when testing Telegram, OAuth callbacks, and the Cloudflare tunnel together:

```bash
npm run dev:local
```

This starts:

```bash
npm run dev:bot
npm run dev:bot:polling
cloudflared tunnel --config ~/.cloudflared/reflection.yaml run reflection
```

The HTTP server handles local API routes and OAuth callbacks. Polling receives Telegram updates during local development.

Telegram webhooks cannot reach `localhost`, so local Telegram testing should use polling unless a public HTTPS webhook URL is configured.

## Google OAuth Local Development

Google Calendar OAuth requires an externally reachable HTTPS `PUBLIC_BASE_URL` if the link should render as a Telegram inline button.

For Cloudflare tunnel development:

```bash
PUBLIC_BASE_URL=https://reflection.yongerong.com
```

The Google OAuth authorized redirect URI must match:

```text
https://reflection.yongerong.com/google-calendar/callback
```

The tunnel config should route that hostname to the local bot server:

```yaml
ingress:
  - hostname: reflection.yongerong.com
    service: http://localhost:8787
  - service: http_status:404
```

If `PUBLIC_BASE_URL` uses `http://localhost:8787`, `/calendar` still works for local desktop testing, but the OAuth URL is sent as plain text because Telegram rejects localhost URLs in inline keyboard buttons.
