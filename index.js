// donenv - Read environment variables from .env file
var dotenv = require('dotenv');
// Needed for crontab to find .env file
dotenv.config({path: '/home/pi/ConnectedElevator/.env'});
dotenv.load();

// Raspicam - Raspberry Pi Camera
const Raspistill = require('node-raspistill').Raspistill;
const camera = new Raspistill({
  verticalFlip: false,
  width: 1296,
  height: 972,
  time: 1000
});

// GPIO - General Purpose I/O pin control
var gpio = require('rpi-gpio');
// Debounce "Motion Detected" hardware button
var debounce = require('debounce');

// Cometd libraries enable subscription to Platform Events
var cometdnodejs = require('cometd-nodejs-client').adapt();
var cometdlib = require('cometd');
var cometd = new cometdlib.CometD();
var TimeStampExtension = require('cometd/TimeStampExtension');
cometd.registerExtension('timestamp', new TimeStampExtension());

// Express - for HTTP messaging
var express = require('express');
var app = express();

// NForce - simplifies authtentication with Salesforce
var nforce = require('nforce');

// Retrieve connection info from environment file
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const USERNAME = process.env.SFUSERNAME;
const PASSWORD = process.env.SFPASSWORD;
const SECURITY_TOKEN = process.env.SECURITY_TOKEN;
const DEVICEID = 'ELEVATOR-001';

const AUTH_URL = 'https://login.salesforce.com/services/oauth2/token';
var access_token;
var salesforce_url;

// Topic paths for the Platform Events
const MOTION_DETECTED_TOPIC = '/event/MotionDetected__e';
const TAKE_RIDER_TO_FLOOR_TOPIC = '/event/TakeRiderToFloor__e';

// Mapping of floors to WiringPi pin numbers of LEDs
const FLOORS = [19, 21, 23, 29, 31, 33, 35, 37];
const photoFilename = 'legoPhoto.jpg';

// Motion Detected button
const MOTION = 36;

// Current location of elevator
var currentFloor = 1;
const idleInterval = 10000;
var floorIntervalTimers = [];
var idleTimer;
var endOfRideTimer;

// Create a connection to the IoT Explorer Salesforce org
var org = nforce.createConnection({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  redirectUri: 'http://localhost:5000/oauth/_callback',
  mode: 'single',
  autoRefresh: true
});

// Authenticate to the org
org.authenticate({
  username: USERNAME,
  password: PASSWORD,
  securityToken: SECURITY_TOKEN
}, function (err, resp) {
  if (err) {
    return console.error('Unable to get security token');
  }
  access_token = resp.access_token;
  salesforce_url = resp.instance_url;
  console.log('Access token ' + access_token);
  console.log('Salesforce URL ' + salesforce_url);

  // Configure the CometD object.
  cometd.configure({
    url: salesforce_url + '/cometd/40.0/',
    requestHeaders: { Authorization: 'Bearer ' + access_token },
    appendMessageTypeToURL: false
  });

  // Handshake with the server and subscribe to the PE.
  cometd.handshake(function (h) {
    if (h.successful) {
      // Subscribe to receive messages from the server.
      cometd.subscribe(MOTION_DETECTED_TOPIC, onMotionDetected);
      console.log('Cometd subscribed to ' + MOTION_DETECTED_TOPIC + ' successfully');
      cometd.subscribe(TAKE_RIDER_TO_FLOOR_TOPIC, onTakeRiderToFloor);
      console.log('Cometd subscribed to ' + TAKE_RIDER_TO_FLOOR_TOPIC + ' successfully');
    } else {
      console.log('Unable to connect to cometd ' + JSON.stringify(h));
    }
  });
});


// Configure the app for HTTP
app.set('port', (process.env.PORT || 5000));
app.use(express.static(__dirname + '/public'));
// views is directory for all template files
app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');



//==============================================================
// local functions
function configureGPIO() {
  // motion sensor switch
  gpio.setup(MOTION, gpio.DIR_IN, gpio.EDGE_RISING);
  // when a GPIO input state change has stablized for one second,
  // handle it.
  gpio.on('change', debounce(motion,1000));

 // Floor controller pins
  for (i = 0; i < 8; i++) {
    gpio.setup(FLOORS[i], gpio.DIR_OUT, function () {
      gpio.write(FLOORS[0], 1);
    });
  }
}

function startIdleTimer() {
  console.log('Idle Timer Started');
  idleTimer = setInterval(function () {
    moveElevatorToRandomFloor()
  },
    idleInterval);
}

function stopIdleTimer() {
  console.log('Idle Timer Stopped');
  clearInterval(idleTimer);
}

function stopFloorIntervalTimer() {
  console.log('Stopping all Floor Interval Timers: ' + floorIntervalTimers.length);
  for (var i = 0; i < floorIntervalTimers.length; i++) {
    clearTimeout(floorIntervalTimers[i]);
  }
  //reset timer array
  floorIntervalTimers = [];
}

function stopEndOfRideTimer() {
  console.log('EndOfRide Timer Stopped');
  clearTimeout(endOfRideTimer);
}

function stopAllTimers() {
  stopEndOfRideTimer();
  // Stop the floor interval timer
  stopFloorIntervalTimer();
  // Stop the idle timer
  stopIdleTimer();
}

function moveElevatorToRandomFloor() {
  var newFloor = Math.floor(Math.random() * FLOORS.length) + 1;
  console.log('Randomly moving elevator to floor ' + newFloor);
  moveElevatorToFloor(newFloor);
}

function setFloor(floor, state) {
  // FLOORS is a zero-based array, so subtract one from floor.
  gpio.write(FLOORS[floor - 1], state);

  if (state) {
    // Send an event to update the floor indicator in the Lighting UI
    var currentFloorEvent = nforce.createSObject('CurrentFloor__e');
    currentFloorEvent.set('DeviceId__c', DEVICEID);
    currentFloorEvent.set('Floor__c', floor);
    org.insert({
      sobject: currentFloorEvent
    },
      function (err, resp) {
        if (err) return console.log(err);
      });
  }
}

function moveElevatorToFloor(floor) {
  if (currentFloor < floor) {
    // Going up
    currentFloor++;
    console.log('... floor ' + currentFloor);
    setFloor(currentFloor - 1, 0);
    setFloor(currentFloor, 1);
    floorIntervalTimers.push(
      setTimeout(
        function () {
          moveElevatorToFloor(floor);
        },
        1000
      )
    );
  };

  if (currentFloor > floor) {
    // Going down
    currentFloor--;
    console.log('... floor ' + currentFloor);
    setFloor(currentFloor + 1, 0);
    setFloor(currentFloor, 1);
    floorIntervalTimers.push(
      setTimeout(
        function () {
          moveElevatorToFloor(floor);
        },
        1000
      )
    );
  };

};

// 
function takePictureAndAlertIoT() {
  var salesforceFileId;
  console.log('TAKE PICTURE');
  camera.takePhoto(photoFilename).then((photo) => {

    console.log('Photo taken');


    // Post the picture as a new ContentVersion (File) in the Salesforce org
    var doc = nforce.createSObject('ContentVersion');
    doc.set('reasonForChange', 'Legoman Image');
    doc.set('pathOnClient', photoFilename);
    doc.setAttachment(photoFilename, photo);

    org.insert({ sobject: doc }, function (err, resp) {
      if (err) return console.log(err);
      salesforceFileId = resp.id;
      console.log('Id of ContentVersion created ' + salesforceFileId);

      // Create the platform event
      var approachingRiderEvent = nforce.createSObject('ApproachingRider__e');
      approachingRiderEvent.set('DeviceId__c', DEVICEID);
      approachingRiderEvent.set('RiderPictureId__c', salesforceFileId);
      org.insert({
        sobject: approachingRiderEvent
      },
        function (err, resp) {
          if (err) return console.log(err);
          console.log('Approaching Rider platform event created ' + resp.id);
        });
    });

  });
};

// Handler for state change on input pins
// If this is the rising edge (release of switch)
// create a platform event.  Since we already have a handler
// for this event (in the case when it is invoked from the
// Salesforce UI), we don't act upon it here.
var motion = function(channel, value) {
  console.log('channel ' + channel + ' value is now ' + value );
  if ((channel == MOTION) && (value)) {

    // Create the platform event
    var motionEvent = nforce.createSObject('MotionDetected__e');
      motionEvent.set('DeviceId__c', DEVICEID);
      org.insert({
        sobject: motionEvent
      },
        function (err, resp) {
          if (err) return console.log(err);
          console.log('Motion Detected platform event created ' + resp.id);
        });

  }
};


//===================================
// Platform Event handlers
//===================================
// Event handler fired when a MotionDetected Platform Event is detected
function onMotionDetected(m) {
  // Stop all timers
  stopAllTimers();

  moveElevatorToFloor(1);

  console.log('Motion has been detected.  Initiating picture cycle');
  takePictureAndAlertIoT();
}

// Event handler fired when the orchestration is commanding to have a rider transported
function onTakeRiderToFloor(m) {
  // Stop all timers
  stopAllTimers();
  
  var dataFromServer = m.data;
  var floor = dataFromServer.payload.Floor__c;

  console.log('Taking rider from floor ' + currentFloor + ' to floor ' + floor);
  moveElevatorToFloor(floor);

  // Wait 30 sec, then tell the Orchestration we are done.
  endOfRideTimer = setTimeout(
    function () {
      // Create the platform event
      var rideCompleteEvent = nforce.createSObject('Ride_Complete__e');
      rideCompleteEvent.set('DeviceId__c', DEVICEID);
      org.insert({
        sobject: rideCompleteEvent
      },
        function (err, resp) {
          if (err) return console.log(err);
          console.log('Ride Complete platform event created ' + resp.id);
        });

      startIdleTimer();

    },
    30000
  );

}

//===================================
// HTTP handlers (only used for testing)
//===================================
// HTTP Get handler /
// Renders the default page.  Mainly for testing.
app.get('/', function (request, response) {
  response.render('pages/index');
});

// HTTP Get handler /TakeRiderToFloor
// Moves the elevator to the desired floor
// Query Parameters:
//   floor  -  The floor to move to
app.get('/TakeRiderToFloor', function (request, response) {
  // Stop all timers
  stopAllTimers();
    
  var floor = request.query.floor;
  console.log('Moving elevator from floor ' + currentFloor + ' to floor ' + floor);

  moveElevatorToFloor(floor);

  startIdleTimer();

  response.send('Moved to floor ' + floor);
});

// HTTP Get handler /riderThisWayCometh
// Triggers the photo process.  This simulates a motion detecting camera
// Query Parameters:
//   none
app.get('/riderThisWayCometh', function (request, response) {
  // Stop all timers
  stopAllTimers();
  
  moveElevatorToFloor(1);


  console.log('A rider has approached the elevator');

  takePictureAndAlertIoT();

  response.send('A rider has approached the elevator');
});

app.listen(app.get('port'), function () {
  console.log('Node app is running on port', app.get('port'));
});

//===================================
// Initialize system
//===================================
configureGPIO();
startIdleTimer();
