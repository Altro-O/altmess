import './globals.css';
import { AuthProvider } from '../components/AuthProvider';
import NotificationManager from '../components/NotificationManager';

export const metadata = {
  title: 'Altmess',
  description: 'Realtime messenger with chat and calls',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: '/altmess.jpeg',
    shortcut: '/altmess.jpeg',
    apple: '/altmess.jpeg',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Altmess',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ru">
      <body className="antialiased">
        <AuthProvider>
          {children}
          <NotificationManager />
        </AuthProvider>
      </body>
    </html>
  );
}
