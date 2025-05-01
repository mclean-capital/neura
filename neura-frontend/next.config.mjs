/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack(config) {
    config.module.rules.push({
      test: /\.svg$/, // Look for .svg files
      use: ["@svgr/webpack"], // Use @svgr/webpack to handle them
    });

    return config; // Always return the modified config
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
        port: '',
        pathname: '/a/**',
      }
    ]
  }
};

export default nextConfig;
