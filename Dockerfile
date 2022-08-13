FROM node:11.15.0-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y locales
RUN sed -i -e 's/# en_US.UTF-8 UTF-8/ru_RU.UTF-8 UTF-8/' /etc/locale.gen && \
    dpkg-reconfigure --frontend=noninteractive locales && \
    update-locale LANG=ru_RU.UTF-8
ENV LANG ru_RU.UTF-8
RUN apt-get update && apt-get -y install python build-essential
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY . .
RUN chmod +x docker-entrypoint.sh
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server"]
