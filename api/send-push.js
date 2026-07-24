import webpush from 'web-push';

webpush.setVapidDetails(
  'mailto:ali.jawad.ext@gmail.com',
  process.env.VITE_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { subscription, title, body, url } = req.body;
  try {
    await webpush.sendNotification(subscription, JSON.stringify({ title, body, url: url || '/' }));
    res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
