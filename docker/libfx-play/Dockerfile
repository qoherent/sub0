FROM node:24-bookworm

# glibc in bookworm (2.36) >= 2.34 required by libfx native addons
WORKDIR /work

# Pin libfx to the version subzero ships against (fx is 0.0.x; floats are unsafe)
RUN npm init -y >/dev/null && npm install libfx@0.0.11 --ignore-scripts=false

# Smoke scripts are mounted from the host (see scripts/)
CMD ["node", "--experimental-wasm-jspi", "smoke.mjs"]
