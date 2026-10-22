'use client';

import StudyApp from '@/components/study-app';
import { useStudy } from '@/lib/use-study';

export default function Home() {
  const controller = useStudy();
  return <StudyApp controller={controller} />;
}
