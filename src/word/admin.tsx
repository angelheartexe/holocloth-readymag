import { createRoot } from 'react-dom/client';
import './theme.ts';
import AdminApp from './AdminApp.tsx';

createRoot(document.getElementById('root')!).render(<AdminApp />);
