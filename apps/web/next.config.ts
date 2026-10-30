import type { NextConfig } from 'next';
import path from 'node:path';
const nextConfig:NextConfig={turbopack:{root:path.resolve(process.cwd(),'../..')},async rewrites(){return [{source:'/api/:path*',destination:`${process.env.API_INTERNAL_URL||'http://127.0.0.1:4000'}/api/:path*`}];}};
export default nextConfig;
