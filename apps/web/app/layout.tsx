import './globals.css';
import type { Metadata } from 'next';
export const metadata:Metadata={title:'Ledgerway | Accounting',description:'Central transaction and reconciliation workspace'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}
