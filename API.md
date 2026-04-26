# ListaPranzo — API Reference

Base URL: `http://<host>:3000/api`

Interactive docs (Swagger UI): `http://<host>:3000/api/docs`  
OpenAPI spec (JSON): `http://<host>:3000/api/docs.json`

---

## Authentication

All protected endpoints require a **Bearer JWT token** in the `Authorization` header.

```
Authorization: Bearer <token>
```

### How to get a token

```http
POST /api/auth/login
Content-Type: application/json

{ "name": "mario", "password": "mypassword" }
```

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "name": "mario",
  "role": "manager",
  "group_id": 2,
  "group_name": "Marketing"
}
```

The token is valid for **30 days**. Store it in your app and include it on every subsequent request.

---

## Roles

| Role | Description |
|---|---|
| `admin` | Full system access. Manages users, groups, data. |
| `manager` | Manages their group's session, orders and votes. |
| `user` | Regular member — can vote, order, manage own preorders. |

> **Backward compatibility:** Manager endpoints also accept `manager_name` in the request body. JWT is recommended for new integrations.

---

## Common Response Formats

### Success
```json
{ "ok": true }
```

### Error
```json
{ "error": "Descrizione dell'errore" }
```

### HTTP Status Codes

| Code | Meaning |
|---|---|
| `200` | OK |
| `201` | Created |
| `400` | Bad request / missing fields |
| `401` | Authentication required or invalid token |
| `403` | Forbidden — insufficient role |
| `404` | Resource not found |
| `409` | Conflict (duplicate, already exists) |

---

## Real-time Updates (WebSocket)

Connect to `ws://<host>:3000` to receive live push events. The server broadcasts a JSON message whenever data changes.

| Event `type` | When it fires |
|---|---|
| `session_updated` | Session state or lock count changed |
| `orders_updated` | An order was placed, updated or deleted |
| `votes_updated` | A vote was cast or cleared |
| `places_updated` | A place was added/edited/deleted |
| `menus_updated` | A menu was saved or cleared |
| `asporto_updated` | An asporto order changed |
| `group_updated` | Group membership or roles changed |
| `join_request_created` | A new join request was submitted |
| `join_request_updated` | A join request was approved/rejected |
| `group_request_created` | A new group creation request was submitted |
| `group_request_updated` | A group request was approved/rejected |
| `audit_updated` | A new audit entry was created |

Each event carries the relevant data. For example `orders_updated` includes the full `orders` array.

---

## Endpoints

### Auth

#### `POST /api/auth/login`
Authenticate any user (admin, manager or user). Returns a signed JWT.

**Request body:**
```json
{ "name": "mario", "password": "mypassword" }
```

**Response:**
```json
{
  "token": "eyJ...",
  "name": "mario",
  "role": "manager",
  "group_id": 2,
  "group_name": "Marketing"
}
```

---

#### `GET /api/auth/me` 🔒
Returns the profile of the currently authenticated user.

**Response:**
```json
{
  "name": "mario",
  "role": "manager",
  "group_id": 2,
  "group_name": "Marketing"
}
```

---

### Users

#### `POST /api/users/register`
Register a new account. New users start with role `user` and no group.

**Request body:**
```json
{ "name": "mario", "password": "mypassword" }
```

---

#### `POST /api/users/login`
Legacy login — validates credentials, returns user info but **no token**.  
Prefer `POST /api/auth/login` for new integrations.

**Request body:**
```json
{ "name": "mario", "password": "mypassword" }
```

**Response:**
```json
{ "name": "mario", "role": "user", "group_id": null, "group_name": null }
```

---

#### `POST /api/users/change-password` 🔒
Change the current user's password.

**Request body:**
```json
{ "name": "mario", "old_password": "old", "new_password": "new" }
```

---

#### `GET /api/users/exists/:name`
Check if a username is already taken.

**Response:**
```json
{ "exists": true }
```

---

### Places

#### `GET /api/places`
List all restaurants/delivery places sorted by name.

**Response:**
```json
[
  {
    "id": 1,
    "name": "La Trattoria",
    "description": "Cucina casalinga",
    "max_dishes": 0,
    "presets": ["Pizza Margherita", "Pasta al pomodoro"]
  }
]
```

---

#### `POST /api/places` 🔒 *(admin)*
Create a new place.

**Request body:**
```json
{ "name": "La Trattoria", "description": "Cucina casalinga" }
```

---

#### `PUT /api/places/:id` 🔒 *(admin)*
Update a place.

**Request body:**
```json
{ "name": "La Trattoria", "description": "...", "max_dishes": 5 }
```

> `max_dishes`: maximum number of selectable preset dishes (0 = unlimited).

---

#### `PATCH /api/places/:id/presets` 🔒 *(admin)*
Replace the preset dish list for a place.

**Request body:**
```json
{ "presets": ["Pizza Margherita", "Pasta al pomodoro", "Insalata mista"] }
```

---

#### `DELETE /api/places/:id` 🔒 *(admin)*

---

### Menus

#### `GET /api/menus/:date`
Get all menus for a date. Date format: `YYYY-MM-DD`.

**Response:**
```json
[
  { "id": 1, "place_id": 1, "place_name": "La Trattoria", "date": "2026-04-26", "menu_text": "Lasagne, Tiramisù" }
]
```

---

#### `POST /api/menus` 🔒
Create or update a menu for a place on a date (upsert).

**Request body:**
```json
{ "place_id": 1, "date": "2026-04-26", "menu_text": "Lasagne, Tiramisù" }
```

---

#### `DELETE /api/menus/:date` 🔒
Delete all menus for a date.

---

### Groups

#### `GET /api/groups`
List all groups with member count. Use this to let users browse groups to join.

**Response:**
```json
[
  { "id": 2, "name": "Marketing", "member_count": 5 }
]
```

---

#### `GET /api/groups/:gid/members` 🔒
List all members of a group.

**Response:**
```json
[
  { "id": 10, "name": "mario", "role": "manager" },
  { "id": 11, "name": "luigi", "role": "user" }
]
```

---

#### `POST /api/groups/:gid/members` 🔒 *(manager/admin)*
Directly add a user to the group (bypasses join request flow).

**Request body:**
```json
{ "user_name": "luigi" }
```

---

#### `DELETE /api/groups/:gid/members/:uname` 🔒 *(manager/admin)*
Remove a member from the group. Cannot remove the last manager.

---

#### `PUT /api/groups/:gid/members/:uname/role` 🔒 *(manager/admin)*
Promote or demote a group member.

**Request body:**
```json
{ "role": "manager" }
```

> `role` must be `"manager"` or `"user"`. Cannot demote the last manager.

---

### Group & Join Requests

Users without a group must go through a request flow:

- **Create a new group** → `POST /api/group-requests` → admin approves
- **Join an existing group** → `POST /api/groups/:gid/join-requests` → manager approves

#### `POST /api/group-requests`
Request to create a new group. The user becomes the group manager upon approval by admin.

**Request body:**
```json
{ "user_name": "mario", "group_name": "Marketing" }
```

---

#### `GET /api/group-requests/my/:name`
Get the user's latest group creation request (or `null`).

**Response:**
```json
{ "id": 3, "user_name": "mario", "group_name": "Marketing", "status": "pending", "created_at": "..." }
```

---

#### `POST /api/groups/:gid/join-requests`
Request to join an existing group.

**Request body:**
```json
{ "user_name": "luigi" }
```

---

#### `GET /api/groups/:gid/join-requests` 🔒 *(manager/admin)*
List pending join requests for a group.

---

#### `PUT /api/groups/:gid/join-requests/:rid/approve` 🔒 *(manager/admin)*
Approve a join request. The user is added to the group.

---

#### `PUT /api/groups/:gid/join-requests/:rid/reject` 🔒 *(manager/admin)*
Reject a join request.

---

#### `GET /api/join-requests/my/:name`
Get the user's latest join request (or `null`).

---

### Session

The session drives the daily lunch workflow for a group:

```
voting  →  ordering  →  closed
```

- **voting**: members vote for a restaurant
- **ordering**: the winning place is set, members place orders
- **closed**: session is over

#### `GET /api/groups/:gid/session/:date`
Get the current session. Creates a new `voting` session if none exists for that date.

**Response:**
```json
{
  "id": 5,
  "date": "2026-04-26",
  "group_id": 2,
  "state": "ordering",
  "winning_place_id": 1,
  "winning_place_ids": [1],
  "timer_end": null,
  "orders_lock_count": 0
}
```

> `orders_lock_count > 0` means orders are locked and new ones are stamped as late (ritardatari).

---

#### `PUT /api/groups/:gid/session/:date` 🔒 *(manager/admin)*
Transition the session state.

**Request body:**
```json
{
  "state": "ordering",
  "winning_place_ids": [1]
}
```

> When moving to `ordering` with a split vote, pass multiple IDs in `winning_place_ids`.

---

#### `POST /api/groups/:gid/session/:date/timer` 🔒 *(manager/admin)*
Start a voting countdown. When it expires, voting closes automatically.

**Request body:**
```json
{ "minutes": 5 }
```

---

#### `DELETE /api/groups/:gid/session/:date/timer` 🔒 *(manager/admin)*
Cancel the countdown timer.

---

#### `PUT /api/groups/:gid/session/:date/lock-orders` 🔒 *(manager/admin)*
Lock orders and start a new late round. Increments `orders_lock_count`.  
New orders after this are stamped as late (`late_round = orders_lock_count`).  
Call again to open another late round.

---

#### `PUT /api/groups/:gid/session/:date/unlock-orders` 🔒 *(manager/admin)*
Decrements `orders_lock_count` (min 0). Allows normal orders again.

---

### Votes

#### `GET /api/groups/:gid/votes/:date`
Get all votes cast for a group on a date.

**Response:**
```json
[
  { "id": 1, "colleague_name": "mario", "place_id": 1, "place_name": "La Trattoria", "date": "2026-04-26", "group_id": 2, "voted_at": "..." }
]
```

---

#### `POST /api/groups/:gid/votes` 🔒
Cast vote(s) for a user. Replaces any previous vote by the same user on the same day.

**Request body:**
```json
{ "place_ids": [1, 3], "colleague_name": "mario", "date": "2026-04-26" }
```

> Pass multiple `place_ids` to vote for multiple places simultaneously.

---

#### `DELETE /api/groups/:gid/votes/:date` 🔒 *(manager/admin)*
Clear all votes and reset the session back to `voting` state.

---

### Preorders

Preorders are dish preferences set in advance. When the session moves to `ordering`, they are automatically converted to actual orders (if the preordered place won).

#### `GET /api/preorders/:date/:colleague_name`
Get a user's preorders for a date.

**Response:**
```json
[
  { "id": 1, "colleague_name": "mario", "place_id": 1, "date": "2026-04-26", "checks": ["Pizza Margherita"], "custom": "senza cipolla" }
]
```

---

#### `PUT /api/preorders/:date/:colleague_name/:place_id` 🔒
Save (upsert) a preorder for a user, place and date.

**Request body:**
```json
{ "checks": ["Pizza Margherita", "Coca Cola"], "custom": "senza cipolla" }
```

> `checks`: array of selected preset dish names. `custom`: free-text addition.

---

### Orders

#### `GET /api/groups/:gid/orders/:date`
Get all orders for a group on a date, sorted by creation time.

**Response:**
```json
[
  {
    "id": 10,
    "colleague_name": "mario",
    "place_id": 1,
    "place_name": "La Trattoria",
    "order_text": "Pizza Margherita, senza cipolla",
    "date": "2026-04-26",
    "group_id": 2,
    "late_round": 0,
    "is_late": false,
    "created_at": "..."
  }
]
```

> `late_round = 0`: normal order. `late_round >= 1`: late order from that lock round.

---

#### `POST /api/groups/:gid/orders` 🔒
Place or update an order (upsert — one order per user per day per group).  
If `orders_lock_count > 0`, the order is automatically stamped as late.

**Request body:**
```json
{
  "colleague_name": "mario",
  "place_id": 1,
  "order_text": "Pizza Margherita, senza cipolla",
  "date": "2026-04-26"
}
```

---

#### `DELETE /api/groups/:gid/orders/:date` 🔒 *(manager/admin)*
Delete all orders for a group on a date.

---

#### `DELETE /api/groups/:gid/orders/:date/:oid` 🔒 *(manager/admin)*
Delete a single order by its ID.

---

### Asporto (Take-away)

Independent take-away orders, not tied to the group lunch.

#### `GET /api/groups/:gid/asporto/:date`
Get all asporto orders for a group on a date.

---

#### `POST /api/groups/:gid/asporto` 🔒
Place or update an asporto order.

**Request body:**
```json
{
  "colleague_name": "mario",
  "place_id": 1,
  "order_text": "Pizza da asporto",
  "date": "2026-04-26"
}
```

---

#### `DELETE /api/groups/:gid/asporto/:date` 🔒 *(manager/admin)*
Delete all asporto orders for a date.

---

#### `DELETE /api/groups/:gid/asporto/:date/:aid` 🔒
Delete a single asporto order.  
Must be either the **order owner** (pass `colleague_name`) or a **manager** (pass `manager_name`).

**Request body:**
```json
{ "colleague_name": "mario" }
```
or
```json
{ "manager_name": "mario" }
```

---

### Admin

All `/api/admin/*` endpoints require `role: admin`.

#### `POST /api/admin/login`
Admin-specific login using only a password (no username). Also returns a JWT token.

**Request body:**
```json
{ "password": "adminpassword" }
```

**Response:**
```json
{ "ok": true, "token": "eyJ..." }
```

> Prefer `POST /api/auth/login` with `{ "name": "admin", "password": "..." }` for consistency.

---

#### `GET /api/admin/users` 🔒 *(admin)*
List all users with their group info.

---

#### `DELETE /api/admin/users/:name` 🔒 *(admin)*
Delete a user. Cannot delete the `admin` account.

---

#### `POST /api/admin/users/:name/reset-password` 🔒 *(admin)*
Force-reset a user's password.

**Request body:**
```json
{ "new_password": "newpassword" }
```

---

#### `GET /api/admin/groups` 🔒 *(admin)*
List all groups with full details: managers, members, today's session state.

---

#### `POST /api/admin/groups` 🔒 *(admin)*
Create a new group.

**Request body:**
```json
{ "name": "Marketing" }
```

---

#### `PUT /api/admin/groups/:gid` 🔒 *(admin)*
Rename a group.

**Request body:**
```json
{ "name": "New Name" }
```

---

#### `DELETE /api/admin/groups/:gid` 🔒 *(admin)*
Delete a group. All members are unassigned.

---

#### `POST /api/admin/groups/:gid/members` 🔒 *(admin)*
Add a user to a group directly (bypasses join request).

**Request body:**
```json
{ "user_name": "luigi" }
```

---

#### `DELETE /api/admin/groups/:gid/members/:uname` 🔒 *(admin)*
Remove a user from a group.

---

#### `PUT /api/admin/groups/:gid/members/:uname/role` 🔒 *(admin)*
Change a group member's role.

**Request body:**
```json
{ "role": "manager" }
```

---

#### `GET /api/admin/group-requests` 🔒 *(admin)*
List all group creation requests.

---

#### `PUT /api/admin/group-requests/:id/approve` 🔒 *(admin)*
Approve a group creation request. Creates the group and assigns the user as manager.

---

#### `PUT /api/admin/group-requests/:id/reject` 🔒 *(admin)*

---

#### `GET /api/admin/sessions/:date` 🔒 *(admin)*
Overview of all groups' sessions for a given date.

---

### Data (Backup)

#### `GET /api/data/export` 🔒 *(admin)*
Download a full JSON backup of all data. Returns a JSON file attachment.

---

#### `POST /api/data/import` 🔒 *(admin)*
Restore from a backup. **⚠️ Replaces ALL existing data.**

**Request body:** the JSON object produced by `/api/data/export`.

---

### Audit

#### `GET /api/audit` 🔒
Get audit log entries sorted by timestamp (newest first). Optionally filter by date and/or group.

**Query parameters:**
| Parameter | Type | Description |
|---|---|---|
| `date` | `YYYY-MM-DD` | Filter by date |
| `group_id` | integer | Filter by group |

---

#### `DELETE /api/audit` 🔒 *(admin)*
Clear audit log entries.

**Query parameters:**
| Parameter | Description |
|---|---|
| `date` | Delete entries for a specific date only. Omit to delete all entries. |

---

## Mobile App Integration Guide

### 1. Register and login

```http
POST /api/users/register
{ "name": "mario", "password": "secure123" }

POST /api/auth/login
{ "name": "mario", "password": "secure123" }
→ save the returned token
```

### 2. Get the user's group and today's session

```http
GET /api/auth/me
Authorization: Bearer <token>
→ { name, role, group_id, group_name }

GET /api/groups/:group_id/session/2026-04-26
→ { state, winning_place_ids, orders_lock_count, ... }
```

### 3. Vote (when state = "voting")

```http
GET /api/places
→ list of restaurants

GET /api/menus/2026-04-26
→ today's menus

POST /api/groups/:gid/votes
Authorization: Bearer <token>
{ "place_ids": [1], "colleague_name": "mario", "date": "2026-04-26" }
```

### 4. Order (when state = "ordering")

```http
POST /api/groups/:gid/orders
Authorization: Bearer <token>
{ "colleague_name": "mario", "place_id": 1, "order_text": "Pizza Margherita", "date": "2026-04-26" }
```

### 5. Handle live updates

Connect a WebSocket to `ws://<host>:3000`.  
Listen for `session_updated` to detect state transitions, `orders_updated` to refresh the order list, etc.

```js
const ws = new WebSocket('ws://192.168.1.100:3000');
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'session_updated') refreshSession(msg.session);
  if (msg.type === 'orders_updated')  refreshOrders(msg.orders);
};
```

### 6. Late orders (ritardatari)

When `orders_lock_count > 0` the manager has locked orders.  
Any order submitted now has `late_round = orders_lock_count`.  
The manager can lock again (incrementing the count) to open additional late rounds.

```http
PUT /api/groups/:gid/session/:date/lock-orders     ← open late round
PUT /api/groups/:gid/session/:date/unlock-orders   ← re-open normal ordering
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `JWT_SECRET` | *(auto-derived)* | Secret used to sign JWT tokens. Set in production for stability across restarts. |
| `JWT_EXPIRES_IN` | `30d` | Token expiry duration (e.g. `7d`, `24h`, `30d`) |
| `JWT_SEED` | `listapranzo-default-seed` | Used to deterministically derive `JWT_SECRET` if `JWT_SECRET` is not set. |
