import Navigation from '../../components/Navigation';
import styles from '../../styles/dashboardLayout.module.css';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className={styles.shell}>
      <Navigation />
      <main className={styles.content}>{children}</main>
    </div>
  );
}
