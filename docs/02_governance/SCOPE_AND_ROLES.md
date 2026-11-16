# Scope, personas and permissions

## Admin (initial user)
May invite staff, configure integrations, edit leads, approve outward communication, manage campaign sending, export/delete data, update budgets, audit logs, schedule calls **manually** (no AI caller).

## Sales staff (future)
Can view assigned leads, record qualification, draft messages and propose meeting times. Cannot connect OAuth, export all data, unlock campaigns or change legal rules without admin grant.

## Analyst (future)
Can view aggregate analytics only; no PII export or outbound.

## Permission matrix
| Action | Admin | Sales | Analyst |
|---|---|---|---|
| Read assigned leads | Yes | Yes | No |
| Research/create leads | Yes | Yes | No |
| View aggregate stats | Yes | Yes | Yes |
| Draft email | Yes | Yes | No |
| Approve/send outbound | Yes | No | No |
| Connect tokens / billing | Yes | No | No |
| Delete/export | Yes | No | No |
| Pause campaigns | Yes | Yes (emergency stop only) | No |

Implement server-side checks, not simply hidden UI. Owner can emergency-stop everything without OAuth connectivity.

## Out of scope
Multi-tenant SaaS billing and resale, scraping data behind authentication, LinkedIn auto-messaging, voice agents, paid data subscriptions without consent, generalized unattended agent with filesystem/internet tools.

## Voice governance (optional)
AI voice is a conditional enhancement, not part of core MVP. Only owner/admin can request voice activation, select a telephony provider, approve budgets, approve named callbacks and change recording status. A compliance reviewer or qualified adviser must sign off before commercial calling. The sales operator can view call summaries only when authorized; lead phone numbers are not a dialer export. See voice governance folder.
