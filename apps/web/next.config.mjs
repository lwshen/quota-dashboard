/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  transpilePackages: ["@quota/core"],
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
