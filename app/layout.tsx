import './globals.css';
import { AuthProvider } from '../components/AuthProvider';
import NotificationManager from '../components/NotificationManager';

export const metadata = {
  title: 'Altmess',
  description: 'Realtime messenger with chat and calls',
  manifest: '/manifest.webmanifest',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="antialiased">
        <AuthProvider>
          {children}
          <NotificationManager />
        </AuthProvider>
      </body>
    </html>
  );
}
