import type { NextConfig } from 'next';
const nextConfig: NextConfig = { output: 'standalone', outputFileTracingRoot: new URL('../..', import.meta.url).pathname, reactStrictMode: true };
export default nextConfig;
