// Adversarial: nested defaults, closure params, generics, string delimiters.
class Svc {
    func nestedDefault(a: Int = g(1, 2), b: Int = h(3)) -> Int {
        return a
    }
    func closureParam(cb: (Int) -> Int, n: Int) -> Int {
        return cb(n)
    }
    func deepGenerics(m: [String: [Int]]) -> Int {
        return m.count
    }
    func stringDelims(sep: String = ")") -> String {
        return sep
    }
}
