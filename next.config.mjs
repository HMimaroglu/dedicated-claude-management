/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["better-sqlite3", "argon2"],
  poweredByHeader: false,
};

export default nextConfig;
