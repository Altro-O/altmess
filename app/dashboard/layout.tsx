import Navigation from '../../components/Navigation';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div>
      <Navigation />
      <main>{children}</main>
    </div>
  );
}
