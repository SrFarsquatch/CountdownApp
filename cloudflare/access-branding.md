# Cloudflare Access branding for Quest Log

Use these values in **Cloudflare Zero Trust -> Reusable components -> Custom pages -> Access login page -> Manage**.

- Organization name: `Quest Log`
- Header: `Welcome back`
- Footer: `Your private planner for calendars, tasks, goals, and everything ahead.`
- Background color: `#f3f2ef`
- Logo: `public/branding/access-logo.svg`
- Alternate compact logo: `public/branding/access-logo-square.svg`

The colors are intentionally aligned with the default Quest Log light theme:

- App background: `#f3f2ef`
- Primary charcoal: `#5f5a52`
- Warm gold: `#c99a45`
- Warm paper: `#f4eddf`
- Text: `#171717`

Keep **Apply instant authentication** disabled if you want users to see the branded Quest Log Access page and then select Google. With only one identity provider, enabling instant authentication skips the Access login page and sends the user directly to Google.

Cloudflare applies Access login-page branding account-wide, so the same login appearance is used by other Access applications in the same Zero Trust organization.
