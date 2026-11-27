FROM node:22-alpine
WORKDIR /app
COPY server.js ./
# Do not run as root.
USER 65532
EXPOSE 8080
CMD ["node", "server.js"]
