import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Telefondan (aynı wifi) dev sunucusuna erişim için gerekli
  allowedDevOrigins: ["192.168.1.134"],
};

export default nextConfig;