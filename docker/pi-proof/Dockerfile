FROM node:24-bookworm
WORKDIR /work
RUN npm init -y >/dev/null && npm install @earendil-works/pi-coding-agent@0.99.1 --ignore-scripts=false 2>&1 | tail -2
CMD ["node", "pi-proof.mjs"]
