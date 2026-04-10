# ── ListaPranzo — Docker image ──────────────────────────────────
# Runs the Express backend which also serves the Admin and Client
# web UIs as static files.
#
# Build:
#   docker build -t listapranzo .
#
# Run (data persisted in a named volume):
#   docker run -d -p 3000:3000 -v listapranzo-data:/app/backend/data --name listapranzo listapranzo
#
# Then open:
#   http://localhost:3000/admin   → Admin UI
#   http://localhost:3000/client  → Client UI
# ────────────────────────────────────────────────────────────────

FROM node:20-alpine

# ── Set production environment ───────────────────────────────────
ENV NODE_ENV=production

# ── Install production dependencies ─────────────────────────────
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev

# ── Copy application code ────────────────────────────────────────
COPY backend/ ./

# ── Copy front-end renderers (served as static files by Express) ─
COPY admin-app/renderer/ /app/admin-app/renderer/
COPY client-app/renderer/ /app/client-app/renderer/

# ── Persist JSON data store across container restarts ───────────
VOLUME ["/app/backend/data"]

# ── Expose port ──────────────────────────────────────────────────
EXPOSE 3000

# ── Health-check ─────────────────────────────────────────────────
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/ || exit 1

# ── Start ────────────────────────────────────────────────────────
CMD ["node", "server.js"]
