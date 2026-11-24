FROM public.ecr.aws/docker/library/node:24-slim
# platform: labs-env needs system CA certs to reach SSM (slim ships none)
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# platform: runs the HTTP server under Lambda
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0 /lambda-adapter /opt/extensions/lambda-adapter
# platform: loads env and secrets from SSM, then execs CMD
COPY --from=878334484542.dkr.ecr.us-east-1.amazonaws.com/bonsai-labs/labs-env:3 /labs-env /usr/local/bin/labs-env
# platform: must equal service.port in labs.yaml; server.js reads PORT
ENV PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENTRYPOINT ["labs-env"]
CMD ["node", "server.js"]
