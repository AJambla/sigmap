// Adversarial control: java uses the shared balanced scanner.
class Svc {
    public int deepGenerics(Map<String, List<Integer>> m) {
        return m.size();
    }
    public int closureParam(Function<Integer, Integer> cb, int n) {
        return cb.apply(n);
    }
}

// #741: a nested type and its members must be attributed to IT, not the outer.
class Outer {
    public int before(int a) { return a; }
    public interface Inner {
        int handle(int b);
    }
    public int after(int c) { return c; }
}
