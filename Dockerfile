# Use lightweight Node image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files first
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy rest of the code
COPY . .

# Expose the Render port
EXPOSE 10000

# Start the app
CMD ["npm", "start"]
