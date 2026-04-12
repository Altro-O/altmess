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
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||((t==='system'||!t)&&matchMedia('(prefers-color-scheme:dark)').matches)){document.documentElement.setAttribute('data-theme','dark')}else{document.documentElement.removeAttribute('data-theme')}}catch(e){}})()` }} />
      </head>
      <body className="antialiased">
        <AuthProvider>
          {children}
          <NotificationManager />
        </AuthProvider>
      </body>
    </html>
  );
}
