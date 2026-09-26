// The Worker the test pool runs. The real entry imports the React Router build, which exists only
// after `react-router build`; the tests drive the gate and the libraries directly instead.
export default {
  fetch() {
    return new Response("test entry", { status: 501 });
  },
} satisfies ExportedHandler;
