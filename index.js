var log4js = require("log4js");
var axios = require("axios");
var async = require("async");

const config = require("./config.js");
const URL = config.orthancUrl + ":" + config.orthancPort;

var studies = [];

// logger
log4js.configure({
  appenders: {
    everything: {
      type: "file",
      filename: "logs/main.log",
      maxLogSize: 10485760,
      backups: 3,
      compress: true,
    },
  },
  categories: {
    default: {
      appenders: ["everything"],
      level: "debug",
    },
  },
});

const logger = log4js.getLogger();
logger.info("Orthanc transfer running.");

// check job status
function jobsStatus() {
  async.forEachOf(studies, (value, key, callback) => {

    if (studies[key].ready == true) {
      callback();
    } else {
      
      axios
        .get(URL + "/jobs/" + studies[key].jobId)
        .then(function (response) {
          if (response.data.Progress == 100) {
            logger.info(
              "READY job ID: " +
                studies[key].jobId +
                " patient: " +
                studies[key].patientName +
                " accessionNo: " +
                studies[key].accessionNumber +
                " studyDate: " +
                studies[key].studyDate
            );
            studies[key].ready = true;
          }
          callback();
        })
        .catch(function (error) {
          callback(error);
        });
    }

  }, (error) => {
    if (error) console.error(error);

    let allReady = true;

    for(let i=0;i<studies.length;i++) {
      if (studies[i].ready == false) {
        allReady = false;
        break;
      }
    }

    if (allReady) {
      logger.info("All sent!");
    } else {
      jobsStatus();
    }
  });
}

// first query
var d = new Date();
d.setDate(d.getDate()-config.prevDays);

function padLeft(n){
  return ("00" + n).slice(-2);
}

let dicomDate = d.getFullYear() + padLeft(d.getMonth()+1) + padLeft(d.getDate());
logger.info("Query from "+ dicomDate+".");

let query = {
  Level: "Study",
  Query: {
    Modality: "MG",
    StudyDate: dicomDate+"-",
  },
  Expand: true,
};

axios
  .post(URL + "/tools/find", query)
  .then(function (response) {
    // search studies
    response.data.forEach((p) => {
      let id,
        accessionNumber,
        studyDate,
        studyInstanceUID,
        patientName,
        patientID = "";

      if (typeof p.ID !== "undefined") {
        id = p.ID;
      }

      if (typeof p.MainDicomTags.AccessionNumber !== "undefined") {
        accessionNumber = p.MainDicomTags.AccessionNumber;
      }

      if (typeof p.MainDicomTags.StudyDate !== "undefined") {
        studyDate = p.MainDicomTags.StudyDate;
      }

      if (typeof p.MainDicomTags.StudyInstanceUID !== "undefined") {
        studyInstanceUID = p.MainDicomTags.StudyInstanceUID;
      }

      if (typeof p.PatientMainDicomTags.PatientName !== "undefined") {
        patientName = p.PatientMainDicomTags.PatientName;
      }

      if (typeof p.PatientMainDicomTags.PatientID !== "undefined") {
        patientID = p.PatientMainDicomTags.PatientID;
      }

      if (p.IsStable) {
        studies.push({
          id: id,
          accessionNumber: accessionNumber,
          studyDate: studyDate,
          studyInstanceUID: studyInstanceUID,
          patientName: patientName,
          patientId: patientID,
          jobId: "",
          ready: false,
        });
      }
    });

    // send studies
    async.forEachOf(studies, (value, key, callback) => {

      axios
        .post(URL + "/modalities/" + config.destination + "/store", {
          Asynchronous: true,
          Permissive: true,
          Resources: [studies[key].id],
        })
        .then(function (response) {
          let jobId = "";

          if (typeof response.data.ID !== "undefined") {
            jobId = response.data.ID;
          }

          logger.info(
            "START job ID: " +
              jobId +
              " patient: " +
              studies[key].patientName +
              " accessionNo: " +
              studies[key].accessionNumber +
              " studyDate: " +
              studies[key].studyDate
          );

          studies[key].jobId = jobId;
          callback();
        })
        .catch(function (error) {
          callback(error);
        });

    }, (error) => {
      if (error) console.error(error);
    
      // starts jobs pooling
      jobsStatus();
    });

  })
  .catch(function (error) {
    throw error;
  });
