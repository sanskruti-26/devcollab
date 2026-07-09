FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 5173

# --host so Vite's dev server accepts connections from outside the container,
# not just localhost inside it
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
