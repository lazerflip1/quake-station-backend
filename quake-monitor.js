const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const { getFirestore } = require('firebase-admin/firestore');
const axios = require('axios');

// Initialize Firebase Admin using the credentials file created in CI from FIREBASE_KEY
const serviceAccount = require('./quake-station-firebase-adminsdk-fbsvc-a63034f825.json');

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();
const messaging = getMessaging();

console.log('Firebase Admin SDK initialized successfully!');

const USGS_URL_BASE = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=1&starttime=';
const NOTIFIED_COLLECTION = 'notified_quakes';
const NOTIFIED_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ─── Distance helper (Haversine, matches the client-side distanceKm) ───────
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ─── Rule matching (mirrors NotificationSettingsService.findMatchingRule) ───
function findMatchingRule(quake, rules) {
  for (const rule of rules) {
    if (quake.mag == null || quake.mag < rule.minMagnitude) continue;

    if (rule.type === 'location') {
      const d = distanceKm(rule.latitude, rule.longitude, quake.lat, quake.lng);
      if (d <= rule.radiusKm) return rule;
    } else if (rule.type === 'region') {
      if (quake.place.toLowerCase().includes(String(rule.region || '').toLowerCase())) {
        return rule;
      }
    }
  }
  return null;
}

function reasonForRule(rule) {
  return rule.type === 'location'
    ? `Within ${rule.radiusKm}km of ${rule.label}`
    : `In region: ${rule.region}`;
}

// ─── Notified-quake dedup (persisted in Firestore, survives across runs) ────
async function loadNotifiedIds(deviceToken) {
  const snap = await db.collection(NOTIFIED_COLLECTION).doc(deviceToken).get();
  if (!snap.exists) return new Set();
  const data = snap.data();
  if (!data.updatedAt || Date.now() - data.updatedAt > NOTIFIED_TTL_MS) return new Set();
  return new Set(data.quakeIds || []);
}

async function saveNotifiedIds(deviceToken, idsSet) {
  await db
    .collection(NOTIFIED_COLLECTION)
    .doc(deviceToken)
    .set({ quakeIds: Array.from(idsSet), updatedAt: Date.now() });
}

// ─── USGS feed ────────────────────────────────────────────────────────────
async function fetchQuakes() {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const url = USGS_URL_BASE + tenMinutesAgo;

  const response = await axios.get(url);
  const features = response.data.features || [];

  return features.map((f) => ({
    id: f.id,
    mag: f.properties.mag,
    place: f.properties.place || '',
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
  }));
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function checkAndNotifyUsers() {
  try {
    console.log('Checking USGS for recent seismic activity...');
    const quakes = await fetchQuakes();

    if (quakes.length === 0) {
      console.log('No new earthquakes detected.');
      return;
    }
    console.log(`Fetched ${quakes.length} quake(s).`);

    const usersSnap = await db.collection('users').get();
    console.log(`Loaded ${usersSnap.size} user(s).`);

    let sentCount = 0;

    for (const userDoc of usersSnap.docs) {
      const user = userDoc.data();
      const deviceToken = user.deviceToken || userDoc.id;

      if (!user.globalEnabled) continue;
      if (!Array.isArray(user.rules) || user.rules.length === 0) continue;
      if (!deviceToken) continue;

      const notifiedIds = await loadNotifiedIds(deviceToken);
      let changed = false;

      for (const quake of quakes) {
        if (notifiedIds.has(quake.id)) continue;
        if (quake.mag == null || quake.mag < (user.globalMinMagnitude ?? 0)) continue;

        const matchingRule = findMatchingRule(quake, user.rules);
        if (!matchingRule) continue;

        let alertEmoji = 'ℹ️';
        if (quake.mag >= 4.0) alertEmoji = '⚠️';
        if (quake.mag >= 6.0) alertEmoji = '🚨';

        const payload = {
          token: deviceToken,
          notification: {
            title: `${alertEmoji} Magnitude ${quake.mag} Earthquake`,
            body: `${quake.place} (${reasonForRule(matchingRule)})`,
          },
          data: {
            earthquakeId: String(quake.id),
            magnitude: String(quake.mag),
          },
          android: {
            priority: quake.mag >= 4.0 ? 'high' : 'normal',
            notification: { channelId: 'default_channel_id' },
          },
        };

        try {
          await getMessaging().send(payload);
          sentCount++;
          notifiedIds.add(quake.id);
          changed = true;
          console.log(`📡 Notified ${deviceToken} about quake ${quake.id} (rule: ${matchingRule.id})`);
        } catch (err) {
          console.error(`Failed to notify ${deviceToken} for quake ${quake.id}:`, err.message);
        }
      }

      if (changed) {
        await saveNotifiedIds(deviceToken, notifiedIds);
      }
    }

    console.log(`Done. Sent ${sentCount} notification(s).`);
  } catch (error) {
    console.error('Error running quake-monitor script:', error);
    process.exitCode = 1;
  }
}

// ─── TESTING ENGINE ─────────────────────────────────────────────────────────
async function testQuakeMonitor() {
  try {
    console.log('🧪 RUNNING LOCAL BACKEND EMULATOR TEST...');
    console.log('📡 Sending mock quake alerts directly to a test device token...');

    // Replace with a real device token captured from your own device
    // (logged by EarthquakeNotificationService on the 'registration' event).
    const TEST_DEVICE_TOKEN = process.env.TEST_DEVICE_TOKEN;

    if (!TEST_DEVICE_TOKEN) {
      console.error('❌ TEST_DEVICE_TOKEN is not set. Export it or add it as a secret before running the test.');
      return;
    }

    const mockQuakes = [
      { id: 'mock_quake_minor', mag: 2.3, place: 'Minor Tremor Alley' },
      { id: 'mock_quake_major', mag: 5.7, place: 'Major Fault Line Blvd' },
    ];

    for (const quake of mockQuakes) {
      let alertEmoji = 'ℹ️';
      if (quake.mag >= 4.0) alertEmoji = '⚠️';
      if (quake.mag >= 6.0) alertEmoji = '🚨';

      const payload = {
        token: TEST_DEVICE_TOKEN,
        notification: {
          title: `${alertEmoji} Test Alert!`,
          body: `A magnitude ${quake.mag} earthquake occurred near ${quake.place}.`,
        },
        data: {
          earthquakeId: String(quake.id),
          magnitude: String(quake.mag),
        },
        android: {
          priority: quake.mag >= 4.0 ? 'high' : 'normal',
          notification: { channelId: 'default_channel_id' },
        },
      };

      await getMessaging().send(payload);
      console.log(`📡 Successfully dispatched Mock Quake (Mag: ${quake.mag}) to test device`);
    }

    console.log('✅ Test complete. Check your device for the notifications.');
  } catch (error) {
    console.error('Error running testing script:', error);
  }
}
// ─── EXECUTION SWITCHBOARD ──────────────────────────────────────────────────
// Toggle comment state on these two lines below to switch modes instantly!

// checkAndNotifyUsers();     // 🟢 Uncomment for Production (rule matching + Firestore)
testQuakeMonitor();           // 🔵 Uncomment for local device-token test
