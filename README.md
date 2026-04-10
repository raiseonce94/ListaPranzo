# ListaPranzo

A simple lunch voting and order aggregation system for small teams.  
Three components: an **Express backend**, an **Admin UI**, and a **Client UI**.

---

## Project Structure

```
ListaPranzo/
├── backend/          ← Express.js server + JSON storage
├── admin-app/        ← Electron admin desktop app
└── client-app/       ← Electron client desktop app
```

---

## Quick Start — Browser Mode (no Electron required)

This is the easiest way to run everything locally.

### 1. Install backend dependencies

```bash
cd backend
npm install
```

### 2. Start the backend

```bash
cd backend
npm start
```

The server starts on **http://localhost:3000**.

### 3. Open the UIs in a browser

| URL | Who uses it |
|-----|------------|
| http://localhost:3000/admin  | Admin |
| http://localhost:3000/client | Each colleague (one tab per person) |

> Colleagues can each open the client URL in their own browser window/tab on their machine. They'll be asked to enter their name on first visit.

---

## Docker Deployment

The easiest way to run ListaPranzo on a server or share it with colleagues who don't have Node installed.

### 1. Build the image

Run this once from the repo root:

```bash
docker build -t listapranzo .
```

### 2. Run the container

```bash
docker run -d \
  -p 3000:3000 \
  -v listapranzo-data:/app/backend/data \
  --name listapranzo \
  --restart unless-stopped \
  listapranzo
```

| Flag | Purpose |
|------|---------|
| `-p 3000:3000` | Expose the app on port 3000 of the host |
| `-v listapranzo-data:/app/backend/data` | Persist JSON data files across container restarts and re-deployments |
| `--restart unless-stopped` | Auto-restart after a reboot |

Then open:

| URL | Who uses it |
|-----|------------|
| http://\<host\>:3000/admin  | Admin |
| http://\<host\>:3000/client | Each colleague |

### 3. Pack the image for offline transfer

Use this to move the image to a machine with no internet access (e.g. an office server behind a firewall):

```bash
# On the build machine — save and compress
docker save listapranzo | gzip > listapranzo.tar.gz
```

Copy `listapranzo.tar.gz` to the target machine (USB, file share, scp, etc.), then:

```bash
# On the target machine — load
docker load < listapranzo.tar.gz
```

Then run the container with the same `docker run` command shown above.

### 4. Update an existing deployment

```bash
# Rebuild the image with the latest code
docker build -t listapranzo .

# Restart the container (data volume is preserved)
docker stop listapranzo && docker rm listapranzo
docker run -d -p 3000:3000 -v listapranzo-data:/app/backend/data --name listapranzo --restart unless-stopped listapranzo
```

> **Tip — backup data before updating:** use the **💾 Dati → Esporta** button in the Admin UI to download a JSON backup, then import it after the update if needed.

---

## Electron Mode (native desktop windows)

If you prefer standalone desktop apps, you can launch them with Electron after downloading the binary.

### Install Electron binary

The Electron binary needs to be downloaded separately (corporate networks may block the download during `npm install`).

1. Go to https://github.com/electron/electron/releases and download the latest `electron-vXX.X.X-win32-x64.zip`
2. Extract `electron.exe` into:
   - `admin-app/node_modules/electron/dist/electron.exe`
   - `client-app/node_modules/electron/dist/electron.exe`
3. Also copy the other files from the zip (resources/, *.dll, etc.) into the same `dist/` folder

Then run each app (with the backend already started):

```bash
# Admin app
cd admin-app
npm start

# Client app (run once per colleague, or multiply on separate machines)
cd client-app
npm start
```

---

## Daily Workflow

### Admin steps
1. Open the **Admin UI** → go to **Ristoranti** tab → add the restaurants
2. Go to **Menu del Giorno** tab → pick today's date → fill in the menu for each place → click **Salva**
3. Go to **Votazioni** tab → watch votes come in live
4. When ready, click **Chiudi Votazione** — this announces the winner and opens the ordering phase
5. Go to **Ordini** tab → watch orders come in → click **Genera Messaggio** → copy and paste into WhatsApp/Telegram

### Colleague steps
1. Open the **Client UI** → enter your name → press Continua
2. Browse the menus → click a restaurant card to select it → press **Vota**
3. Once the admin closes voting, the ordering screen appears automatically
4. Type your order → press **Invia Ordine**
5. Done — the admin will see your order immediately

---

## Architecture Notes

| Component | Tech |
|-----------|------|
| Backend | Node.js + Express.js |
| Real-time | WebSocket (`ws` package) |
| Storage | JSON files in `backend/data/` (zero compilation needed) |
| Admin app | Electron (or browser at `/admin`) |
| Client app | Electron (or browser at `/client`) |

### Data files

All data is stored as JSON files in `backend/data/`:

```
backend/data/
├── places.json   ← restaurant list
├── menus.json    ← daily menus per place
├── session.json  ← today's voting state
├── votes.json    ← votes per colleague per day
└── orders.json   ← orders per colleague per day
```

Data accumulates across days (each day is independent). To reset, delete the JSON files.

### Session states

| State | Meaning |
|-------|---------|
| `voting` | Clients can vote; order form is hidden |
| `ordering` | Voting closed; clients see the winner and can submit their order |
| `closed` | Everything closed for the day |

The admin can re-open voting from the **Votazioni** tab at any time (e.g. to fix a mistake).

---

## Requirements

- **Node.js** v16 or newer
- **npm** v8 or newer
- Modern browser (Chrome, Firefox, Edge) for browser mode
- Electron binary for desktop mode (see above)
