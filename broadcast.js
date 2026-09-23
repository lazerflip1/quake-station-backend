const admin = require('firebase-admin');
const axios = require('axios');

// 1. Initialize Firebase Admin using your downloaded Spark Plan credentials
const serviceAccount = require('./your-downloaded-service-account-key.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

async function checkAndBroadcastEarthquakes() {
  try {
    console.log('Checking USGS for recent seismic activity...');
    
    // Fetch earthquakes above magnitude 4.0 from the last 10 minutes
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const usgsUrl = `https://usgs.gov{tenMinutesAgo}&minmagnitude=4.0`;
    
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

      // Match the topic naming convention used in your Angular app
      const targetGridTopic = `grid_lat${Math.round(lat)}_lng${Math.round(lng)}`;

      const payload = {
        topic: targetGridTopic,
        notification: {
          title: '⚠️ Earthquake Alert Nearby!',
          body: `A magnitude ${mag} earthquake occurred near ${place}.`,
        },
        data: {
          earthquakeId: id,
          magnitude: mag.toString()
        },
        android: {
          priority: 'high', // Bypasses Android battery saver restrictions
          notification: {
            sound: 'default',
            clickAction: 'FCM_PLUGIN_ACTIVITY' // Ensures Capacitor opens the app on tap
          }
        }
      };

      // FCM transmissions are 100% free and unlimited on the Spark Plan
      await admin.messaging().send(payload);
      console.log(`📡 Broadcasted alert for ${id} to topic: ${targetGridTopic}`);
    }
  } catch (error) {
    console.error('Error running broadcast script:', error);
  }
}

// Run the script
checkAndBroadcastEarthquakes();
