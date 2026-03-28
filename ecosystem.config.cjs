module.exports = {
  apps: [
    {
      name: 'deploy-app',
      script: 'npx',
      args: 'wrangler pages dev dist --d1=deploy-production --local --ip 0.0.0.0 --port 3000',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        // Server-side secrets (never exposed to client)
        JWT_SECRET: 'deploy-dev-jwt-secret-change-in-production-minimum-32-chars',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        STRIPE_SECRET_KEY: '',
        RESEND_API_KEY: '',
        APP_URL: 'http://localhost:3000',
        ENVIRONMENT: 'development'
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
    }
  ]
}
