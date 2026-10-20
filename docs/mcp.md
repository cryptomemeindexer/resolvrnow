# ResolvrNow MCP server

ResolvrNow exposes its IT service management data and actions to AI assistants through the
[Model Context Protocol](https://modelcontextprotocol.io). Any MCP client (Claude Desktop,
Claude Code, IDE agents, your own agents) can read and update incidents, problems, changes and
requests, search knowledge, look up configuration items, users and groups.

Every tool call runs **as the user who owns the API token**: access controls, business rules and
auditing apply exactly as in the web UI or the REST API. A requester (a user without an agent
role) only sees their own records, never sees work notes, and can only comment on, escalate or
resolve their own incidents.

Two transports are available:

| Transport | How | Typical use |
|---|---|---|
| stdio | `npx tsx server/src/modules/ai/mcp-stdio.ts --token <token>` | Claude Desktop or Claude Code on the server host, local agents |
| Streamable HTTP | `POST https://<host>/api/app/mcp` with `Authorization: Bearer <token>` | Remote clients, hosted agents |

## 1. Prerequisites

### Role

Users need the `mcp_user` role (administrators hold it implicitly). The required role is set by
the system property `resolvr.mcp.required_role`; set it to an empty value to allow any
authenticated user.

### API token

Create a personal API token for the user the client will act as. Tokens are shown once and
stored hashed in `sys_api_token`.

- From the command line on the server:

  ```sh
  npx tsx server/src/cli/index.ts token <user_name> "Claude Desktop"
  ```

- Or, signed in to ResolvrNow (session or Basic authentication, not with another token):

  ```sh
  curl -u alex.rivera:password -H 'Content-Type: application/json' \
    -d '{"name": "Claude Desktop", "expires": "2027-01-31 00:00:00"}' \
    https://resolvr.example.com/api/app/mcp/tokens
  ```

  The response holds `result.token`. The `expires` field is optional.

Tokens are listed under **AI & Automation > MCP Access Tokens**. Set a token's `active` field to
false to revoke it. A token authenticates the whole REST API for its owner, so prefer a
dedicated user with only the roles the assistant needs, and give tokens an expiry date.

## 2. stdio transport

```sh
npx tsx server/src/modules/ai/mcp-stdio.ts --token <token> [--db <sqlite file>]
```

The process opens the ResolvrNow database directly (SQLite in WAL mode, so the web server can
keep running), checks the token and serves MCP on stdin/stdout. Logs go to stderr.

| Option or variable | Meaning |
|---|---|
| `--token`, `RESOLVRNOW_TOKEN` | API token of the user to act as (required) |
| `--db`, `RESOLVRNOW_DB_FILE` | SQLite file; otherwise `RESOLVRNOW_DATA_DIR/resolvrnow.sqlite` (default `./data`) |
| `RESOLVRNOW_MODULES` | Restrict the modules booted, as for the server |
| `RESOLVRNOW_PUBLIC_URL` | Base URL used in record links returned by the tools |

Point the client at the same database file as the server. When the server is started with
`npm run dev`, the default database is `server/data/resolvrnow.sqlite`, so pass an absolute path.

### Claude Desktop

Add the server to `claude_desktop_config.json` (Settings > Developer > Edit Config):

```json
{
  "mcpServers": {
    "resolvrnow": {
      "command": "npx",
      "args": ["tsx", "/opt/resolvrnow/server/src/modules/ai/mcp-stdio.ts"],
      "env": {
        "RESOLVRNOW_TOKEN": "resolvr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "RESOLVRNOW_DB_FILE": "/opt/resolvrnow/server/data/resolvrnow.sqlite",
        "RESOLVRNOW_PUBLIC_URL": "https://resolvr.example.com"
      }
    }
  }
}
```

Restart Claude Desktop; the ResolvrNow tools appear in the tools menu.

### Claude Code

```sh
claude mcp add resolvrnow \
  -e RESOLVRNOW_TOKEN=resolvr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  -e RESOLVRNOW_DB_FILE=/opt/resolvrnow/server/data/resolvrnow.sqlite \
  -- npx tsx /opt/resolvrnow/server/src/modules/ai/mcp-stdio.ts
```

## 3. Streamable HTTP transport

The endpoint is `/api/app/mcp`. It is **disabled by default**: set the system property
`resolvr.mcp.enabled` to `true`. While disabled the endpoint answers 404. The demo data enables
it and gives the `mcp_user` role to every agent.

- Stateless server: send every JSON-RPC message with `POST`; responses are JSON (no session id,
  no server-sent events). `GET` and `DELETE` answer 405.
- Send `Accept: application/json, text/event-stream` and `Content-Type: application/json`.
- Authentication: `Authorization: Bearer <token>`. Without credentials the endpoint answers 401
  with `WWW-Authenticate: Bearer`; without the MCP role, 403.
- Requests from a browser must come from the ResolvrNow origin (DNS rebinding protection).

```sh
TOKEN=resolvr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
URL=https://resolvr.example.com/api/app/mcp
H=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')

curl -s "${H[@]}" "$URL" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
curl -s "${H[@]}" "$URL" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
curl -s "${H[@]}" "$URL" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"incident_get_details","arguments":{"number":"INC0010001"}}}'
```

### Claude Code (HTTP)

```sh
claude mcp add --transport http resolvrnow https://resolvr.example.com/api/app/mcp \
  --header "Authorization: Bearer resolvr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Or in a project `.mcp.json` (the token is read from the environment):

```json
{
  "mcpServers": {
    "resolvrnow": {
      "type": "http",
      "url": "https://resolvr.example.com/api/app/mcp",
      "headers": { "Authorization": "Bearer ${RESOLVRNOW_TOKEN}" }
    }
  }
}
```

### Clients that only speak stdio

Use the stdio transport on the server host, or a stdio-to-HTTP bridge such as `mcp-remote`
configured with the same URL and `Authorization` header.

## 4. Tools

Tool names use underscores by default. Set `resolvr.mcp.tool_names` to `dotted` to expose the
dotted compatibility names instead. `tools/list` only shows the tools the user may call, and
tools for applications that are not installed (for example change management) are hidden.

| Tool | Dotted name | Who | What it does |
|---|---|---|---|
| `incident_get_details` | `sn_itsm_mcp_server.incident.get_details` | agents; requesters for their own incidents | One incident with its activity. Requesters get a reduced field set and comments only. |
| `incident_search` | `resolvr.incident.search` | agents | Encoded query and/or keywords, paged. |
| `incident_search_similar` | `sn_itsm_mcp_server.incident.search_similar` | agents | Incidents similar to an incident or to free text, with a 0-100 score. |
| `incident_create` | `resolvr.incident.create` | everyone | Agents may set caller, assignment and CI; others create an incident for themselves. |
| `incident_modify` | `sn_itsm_mcp_server.incident.modify` | agents; requesters on their own incidents | Agents: work notes, comments, reassignment, resolution, other writable fields. Requesters: comment, escalate (with a reason), resolve (confirmation required). |
| `task_add_note` | `resolvr.task.add_note` | agents; requesters on their own records | Work note or comment on any task by number. |
| `incident_search_similar_kb` | `sn_itsm_mcp_server.incident.search_similar_kb` | agents | Published knowledge articles for a query or an incident. |
| `incident_get_kb_details` | `sn_itsm_mcp_server.incident.get_kb_details` | agents | One published article with its body. |
| `incident_attach_kb` | `sn_itsm_mcp_server.incident.attach_kb` | agents with write access | Links an article to an incident. |
| `requester_create_incident` | `sn_itsm_mcp_server.requester.create_incident` | signed-in user | Guided creation: knowledge suggestions, duplicate check among the user's open incidents, review, submit. |
| `requester_check_status` | `sn_itsm_mcp_server.requester.check_status` | signed-in user | Status of the user's own incident or requested item, by number or by a phrase such as "my latest ticket". |
| `request_modify` | `sn_itsm_mcp_server.request.modify` | signed-in user | Comment on the user's own open requested item (when the catalog is installed). |
| `problem_get_details` | `resolvr.problem.get_details` | agents | A problem with cause, workaround, fix notes and linked incidents. |
| `problem_search` | `resolvr.problem.search` | agents | Encoded query and/or keywords. |
| `change_query` | `sn_itsm_mcp_server.change.query` | change readers | `read`, `search`, `get_state_info`, `similar_change_and_issues`. |
| `change_lifecycle` | `sn_itsm_mcp_server.change.lifecycle` | change writers | `create`, `update` (state transitions need confirmation). |
| `cmdb_ci_lookup` | `resolvr.cmdb.ci_lookup` | agents | Configuration items by name, class, IP address, serial number or query. |
| `lookup_users` | `sn_itsm_mcp_server.lookup_users` | agents | Active users by name, role or group. |
| `lookup_assignment_groups` | `sn_itsm_mcp_server.lookup_assignment_groups` | agents | Groups by name, optionally with members. |
| `get_session_timezone` | `sn_itsm_mcp_server.get_session_timezone` | everyone | The user's time zone and the current date-time. |
| `task_approval_decision` | `sn_itsm_mcp_server.task_approval_decision` | approvers | Approve or reject the oldest approval waiting for the user (confirmation required). |

"Agents" means the `itil` role (or `sn_incident_read` for read tools and `sn_incident_write`
for write tools). Change readers hold `itil`, `sn_change_read`, `sn_change_write` or
`change_manager`.

Results carry both `structuredContent` and a JSON text copy.

### Errors

Business errors are tool results with `isError: true` and
`{"error": {"code": "...", "message": "..."}}`:

| Code | Meaning |
|---|---|
| `NOT_FOUND` | The record does not exist or the user may not see it |
| `FORBIDDEN` | The user's roles or access controls do not allow the action |
| `INVALID_STATE` | The record's state does not allow it (for example escalating a resolved incident) |
| `VALIDATION` | Missing or invalid arguments |
| `CONFIRMATION_REQUIRED` | The action needs explicit confirmation (see below) |

### Confirmation

Requester resolution, change state transitions and approval decisions first answer
`CONFIRMATION_REQUIRED` with a `confirmation_token` and a `preview`. Show the preview to the
user and, once they agree, call the tool again with the same arguments plus the
`confirmation_token`. Tokens are valid for 10 minutes and are bound to the user, the tool and
the action.

## 5. Resources and prompts

| Resource | Content |
|---|---|
| `resolvrnow://incident/{number}` | An incident as JSON |
| `resolvrnow://change/{number}` | A change request as JSON |
| `resolvrnow://kb/{number}` | A knowledge article as JSON |
| `resolvrnow://user/me` | The user the session acts as |

Prompt templates: `summarize_incident`, `draft_resolution_notes`, `triage_incident` (argument
`number`).

## 6. Audit

Every tool call is written to `resolvr_mcp_call_log` (**AI & Automation > MCP Call Log**): user,
transport, client, tool, operation, a hash of the arguments, the record touched, the outcome and
the duration. Changes made through tools also appear in the record's history under the token
owner's name.
