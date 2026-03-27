'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function DashboardHome() {
  const router = useRouter();

  useEffect(() => {
    // Перенаправляем на страницу чата по умолчанию
    router.push('/dashboard/chat');
  }, [router]);

  return null; // Не отображаем ничего, так как происходит перенаправление
}