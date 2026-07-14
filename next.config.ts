import type { NextConfig } from "next";

/**
 * Deliberately close to empty.
 *
 * The frontend deploys to Vercel, which supplies the build target itself — so there is no `output`
 * setting here. (`standalone` would be the right answer for a self-hosted Node target; it is the wrong
 * answer here, and setting it would have Vercel building an artifact it then has to work around.)
 *
 * The backend is not here and cannot be: the WebSocket relay needs a long-lived process, which a
 * serverless function is not (ARCHITECTURE.md C10). It runs on EC2 under pm2.
 */
const nextConfig: NextConfig = {};

export default nextConfig;
