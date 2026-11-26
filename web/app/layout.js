import { ClerkProvider } from '@clerk/nextjs';
import { Fraunces, Source_Sans_3 } from 'next/font/google';
import Header from '@/components/Header';
import './globals.css';

const display = Fraunces({
  subsets: ['latin'],
  variable: '--font-display-family',
});

const body = Source_Sans_3({
  subsets: ['latin'],
  variable: '--font-body-family',
});

export const metadata = {
  title: 'BMS — Book your seat',
  description: 'Book movie seats with real holds, auth, and confirmation email.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${body.variable}`}>
        <ClerkProvider>
          <Header />
          <main>{children}</main>
        </ClerkProvider>
      </body>
    </html>
  );
}
