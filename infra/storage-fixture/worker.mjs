const syntheticStorageWorker = {
  fetch() {
    return new Response("S04 synthetic storage fixture");
  },
};

export default syntheticStorageWorker;
