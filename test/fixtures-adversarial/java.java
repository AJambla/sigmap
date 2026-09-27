// Adversarial control: java uses the shared balanced scanner.
class Svc {
    public int deepGenerics(Map<String, List<Integer>> m) {
        return m.size();
    }
    public int closureParam(Function<Integer, Integer> cb, int n) {
        return cb.apply(n);
    }
}
