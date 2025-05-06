FROM node:20-slim AS base

WORKDIR /app

# throw away build stage to reduce size of final image
FROM base AS build

RUN apt-get update -qq && apt-get install --no-install-recommends -y ca-certificates
COPY . .

RUN npm i
RUN npm run build

FROM base
COPY --from=build /app /app
COPY --from=build /etc/ssl/certs /etc/ssl/certs

# Expose running port
EXPOSE 8081

# Run the project
CMD ["npm", "start"]