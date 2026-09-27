// Adversarial: nested defaults, generics, closure params.
class Svc {
    public int NestedDefault(int a, int b = G(1, 2)) {
        return a + b;
    }
    public int DeepGenerics(Dictionary<string, List<int>> m) {
        return m.Count;
    }
    public int ClosureParam(Func<int, int> cb, int n) {
        return cb(n);
    }
}
