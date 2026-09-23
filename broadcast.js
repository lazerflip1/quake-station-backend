// 🌟 Fixed: Import both initializeApp AND cert directly from 'firebase-admin/app'
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

async function checkAndBroadcastEarthquakes() {
  try {
    console.log('Checking USGS for recent seismic activity...');
    
    // Fetch earthquakes above magnitude 4.0 from the last 10 minutes
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    
    // Correct, complete USGS API GeoJSON
    const usgsUrl = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&endtime=' + tenMinutesAgo + '&minmagnitude=4'

    
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

      // Modern syntax: Use getMessaging() instead of admin.messaging()
      await getMessaging().send(payload);
      console.log(`📡 Broadcasted alert for ${id} to topic: ${targetGridTopic}`);
    }
  } catch (error) {
    console.error('Error running broadcast script:', error);
  }
}

// Run the script
checkAndBroadcastEarthquakes();
