FROM node:22-alpine

# Setup work directory
ARG APP_DIR=app
RUN mkdir -p ${APP_DIR}
WORKDIR ${APP_DIR}

# Copy project files
COPY . .

# Install dependencies, build and remove dependencies  
RUN npm i --platform=linux --arch=x64 && npm run build

# Expose running port
EXPOSE 8081

# Run the project
CMD ["npm", "start"]