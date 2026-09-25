const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const axios = require('axios');

// 1. Initialize Firebase Admin using your downloaded Spark Plan credentials
const serviceAccount = require('./quake-station-firebase-adminsdk-fbsvc-a63034f825.json');

// Initialize with the clean sub-module functions
initializeApp({
  credential: cert(serviceAccount)
});

console.log('Firebase Admin SDK initialized successfully!');

// ─── PRODUCTION LOGIC ───────────────────────────────────────────────────────
async function checkAndBroadcastEarthquakes() {
  try {
    console.log('Checking USGS for recent seismic activity...');
    
    // Fetch earthquakes above magnitude 1.0 from the last 10 minutes
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    
    // Correct, complete USGS API GeoJSON
    const usgsUrl = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=' + tenMinutesAgo + '&minmagnitude=1'

    const response = await axios.get(usgsUrl);
    const earthquakes = response.data.features;

    if (!earthquakes || earthquakes.length === 0) {
      console.log('No new earthquakes detected.');
      return;
    }

    for (const quake of earthquakes) {
      const id = quake.id;
      const mag = quake.properties.mag;
      const place = quake.properties.place;
      const [lng, lat] = quake.geometry.coordinates;

      let alertEmoji = 'ℹ️'; 
      if (mag >= 4.0) alertEmoji = '⚠️';
      if (mag >= 6.0) alertEmoji = '🚨';

      // Match the topic naming convention used in your Angular app
      const targetGridTopic = `grid_lat${Math.round(lat)}_lng${Math.round(lng)}`;

      const payload = {
        topic: targetGridTopic,
        data: {
          earthquakeId: id,
          magnitude: mag.toString(),
          title: `${alertEmoji} Earthquake Alert Nearby!`,
          body: `A magnitude ${mag} earthquake occurred near ${place}.`
        },
        android: {
          priority: mag >= 4.0 ? 'high' : 'normal',
        }
      };

      // Modern syntax: Use getMessaging() instead of admin.messaging()
      await getMessaging().send(payload);
      console.log(`📡 Broadcasted alert for ${id} to topic: ${targetGridTopic}`);
    }
  } catch (error) {
    console.error('Error running broadcast script:', error);
  }
}

// ─── TESTING ENGINE LOGIC ───────────────────────────────────────────────────
async function testBroadcastScript() {
  try {
    console.log('🧪 RUNNING LOCAL BACKEND EMULATOR TEST...');
    console.log('📡 Broadcasting test payloads to the app dev track...');
    
    const mockEarthquakes = [
      { id: "mock_quake_minor", mag: "2.3", place: "Minor Tremor Alley" },
      { id: "mock_quake_major", mag: "5.7", place: "Major Fault Line Blvd" }
    ];

    for (const quake of mockEarthquakes) {
      let alertEmoji = 'ℹ️'; 
      if (parseFloat(quake.mag) >= 4.0) alertEmoji = '⚠️';
      if (parseFloat(quake.mag) >= 6.0) alertEmoji = '🚨';

      const payload = {
        topic: "global-test-feed",
        // ✅ CRUCIAL FIX: Ensure every value in the data block is explicitly cast as a string
        data: {
          earthquakeId: String(quake.id),
          magnitude: String(quake.mag),
          title: String(`${alertEmoji} Test Alert!`),
          body: String(`A magnitude ${quake.mag} earthquake occurred near ${quake.place}.`)
        },
        android: {
          priority: parseFloat(quake.mag) >= 4.0 ? 'high' : 'normal'
        }
      };

      await getMessaging().send(payload);
      console.log(`📡 Successfully dispatched Mock Quake (Mag: ${quake.mag}) to dev track`);
    }
  } catch (error) {
    console.error('Error running testing script:', error);
  }
}


// ─── EXECUTION SWITCHBOARD ──────────────────────────────────────────────────
// Toggle comment state on these two lines below to switch modes instantly!

// checkAndBroadcastEarthquakes(); // 🟢 Uncomment for Production (USGS Scraping)
testBroadcastScript();          // 🔵 Uncomment for Local Slider Verification Testing
