import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Altmess',
    short_name: 'Altmess',
    description: 'Realtime messenger with messages and calls',
    start_url: '/',
    display: 'standalone',
    background_color: '#f4f6fb',
    theme_color: '#1f6fff',
    icons: [
      {
        src: '/altmess.jpeg',
        sizes: '192x192',
        type: 'image/jpeg',
      },
      {
        src: '/altmess.jpeg',
        sizes: '512x512',
        type: 'image/jpeg',
      },
      {
        src: '/altmess.jpeg',
        sizes: '512x512',
        type: 'image/jpeg',
        purpose: 'maskable',
      },
    ],
  };
}
