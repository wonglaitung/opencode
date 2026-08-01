FROM oven/bun:1
WORKDIR /app
COPY dist/collector ./
EXPOSE 8787
VOLUME /data
ENV OPENCODE_SM_COLLECTOR_DB=/data/collector.db
CMD ["bun", "index.js"]
