/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["better-sqlite3", "argon2", "ssh2", "cpu-features", "ws", "node-pty"],
  poweredByHeader: false,
};

export default nextConfig;
